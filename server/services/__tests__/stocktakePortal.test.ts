// اختبارات تشغيلية لبوابة العدّ الخارجية — countPortalService (العقد docs/stocktake-contract.md §٥).
//
// تغطّي: مصادقة PIN/USER والكوكي (count_token)، قفل PIN بعد ٥ فشلات و١٥ دقيقة، الجرد
// الأعمى (شكل مخرج state فعلياً — لا expectedQty ولا تكاليف ولا كميات زملاء)، النطاق
// (صنف خارج الجلسة يُرفض)، dupPolicy: BLOCK يرفض وVERIFY مطابق/مخالف (isConflict)
// والعدّ الثالث يمسح التعارض، تحديث FIRST الذاتي بلا تكرار صفّ، idempotency بتكرار
// clientRequestId، وfinish: آخر تكليف ينقل الجلسة REVIEW.
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  authenticatePin,
  COUNT_COOKIE_NAME,
  finishAssignment,
  getPortalState,
  resolvePortalIdentity,
  submitCount,
  type PortalIdentity,
} from "../countPortalService";
import {
  computeStocktakeReview,
  createStocktakeSession,
  monitorStocktakeSession,
  requestStocktakeRecount,
  type CreateStocktakeInput,
} from "../stocktakeService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1 };

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

/** بذرة أساس خاصة بالاختبار: فرع + مستخدمان + ٣ متغيّرات (الأول بوحدتين وباركودين). */
async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "أحمد المدير", role: "admin", loginMethod: "local" },
    { id: 2, openId: "local_user", name: "كريم المخزن", role: "warehouse", branchId: 1, loginMethod: "local" },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف" },
    { id: 2, name: "دفتر 100 ورقة" },
    { id: 3, name: "حبر طابعة HP" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "50.00" },
    { id: 3, productId: 3, sku: "INK-1", costPrice: "10000.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-PEN-1" },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "BC-PEN-12" },
    { id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 50 },
    { variantId: 3, branchId: 1, quantity: 20 },
  ]);
}

/** جلسة بوابة قياسية: عاملان PIN، أ يملك الصنف 1 وب يملك الصنف 2. */
async function mkPortalSession(over: Partial<CreateStocktakeInput> = {}) {
  return createStocktakeSession(
    {
      name: "جرد بوابة",
      branchId: 1,
      scopeType: "MANUAL",
      variantIds: [1, 2],
      assignments: [
        { name: "عامل أ", method: "PIN", zone: "رف القرطاسية", variantIds: [1] },
        { name: "عامل ب", method: "PIN", zone: "رف الدفاتر", variantIds: [2] },
      ],
      ...over,
    },
    actor
  );
}

/** دخول البوابة بـPIN وبناء هوية العدّ كما يفعل الراوتر. */
async function loginPin(sessionCode: string, pin: string): Promise<PortalIdentity> {
  const r = await authenticatePin(null, { sessionCode, pin });
  return {
    session: r.session,
    assignment: r.assignment,
    countedByName: r.assignment.name,
    countedByUserId: null,
    mode: "PIN",
  };
}

function submit(identity: PortalIdentity, variantId: number, qty: number, opts: { rid?: string; unitBreakdown?: string } = {}) {
  return submitCount(identity, {
    variantId,
    qty,
    unitBreakdown: opts.unitBreakdown ?? null,
    clientRequestId: opts.rid ?? randomUUID(),
  });
}

async function countRowsOf(sessionId: number, variantId: number) {
  const rows = await db()
    .select()
    .from(s.stocktakeCounts)
    .where(and(eq(s.stocktakeCounts.sessionId, sessionId), eq(s.stocktakeCounts.variantId, variantId)));
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

async function assignmentRow(assignmentId: number) {
  return (await db().select().from(s.stocktakeAssignments).where(eq(s.stocktakeAssignments.id, assignmentId)))[0];
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

/** PIN خاطئ مضمون الاختلاف عن الصحيح. */
const wrongPinFor = (pin: string) => (pin === "0000" ? "1111" : "0000");

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("مصادقة البوابة", () => {
  it("PIN صحيح ⇒ توكن كوكي يحلّ الهوية؛ رمز جلسة خاطئ ⇒ غير متاحة؛ بلا هوية ⇒ UNAUTHORIZED", async () => {
    const r = await mkPortalSession();
    const pinA = r.assignments[0].pin!;

    const auth = await authenticatePin(null, { sessionCode: r.code, pin: pinA });
    expect(auth.mode).toBe("PIN");
    expect(auth.assignment.name).toBe("عامل أ");
    expect(auth.token).toBeTruthy();

    // التوكن في الكوكي يحلّ الهوية للجلسة نفسها (كما يفعل state/submit في الراوتر).
    const ctx = { req: { headers: { cookie: `${COUNT_COOKIE_NAME}=${auth.token}` } }, user: null } as any;
    const identity = await resolvePortalIdentity(ctx, r.code);
    expect(Number(identity.assignment.id)).toBe(r.assignments[0].assignmentId);
    expect(identity.mode).toBe("PIN");

    await expectTrpc(authenticatePin(null, { sessionCode: "CNT-2099-9999", pin: pinA }), "NOT_FOUND");
    await expectTrpc(
      resolvePortalIdentity({ req: { headers: {} }, user: null } as any, r.code),
      "UNAUTHORIZED"
    );
  });

  it("تكليف USER: مستخدم النظام المرتبط يدخل بلا PIN، وغير المرتبط يُرفض", async () => {
    const r = await mkPortalSession({
      assignments: [
        { name: "كريم المخزن", method: "USER", userId: 2, variantIds: [1] },
        { name: "عامل ب", method: "PIN", variantIds: [2] },
      ],
    });
    const user2 = (await db().select().from(s.users).where(eq(s.users.id, 2)))[0];
    const auth = await authenticatePin(user2 as any, { sessionCode: r.code });
    expect(auth.mode).toBe("USER");
    expect(auth.token).toBeNull();
    expect(Number(auth.assignment.id)).toBe(r.assignments[0].assignmentId);

    const identity = await resolvePortalIdentity({ req: { headers: {} }, user: user2 } as any, r.code);
    expect(identity.mode).toBe("USER");
    expect(identity.countedByUserId).toBe(2);

    const user1 = (await db().select().from(s.users).where(eq(s.users.id, 1)))[0];
    await expectTrpc(authenticatePin(user1 as any, { sessionCode: r.code }), "FORBIDDEN", /تكليف/);
  });

  it("PIN خاطئ متكرّر لا يقفل التكليفات (المنع موكول لحدّ معدّل IP في server/index.ts)", async () => {
    // إصلاح أمني: كان PIN خاطئ يزيد العدّاد على كل تكليفات PIN في الجلسة ويقفلها جميعها بعد ٥ ⇒
    // مهاجم على رابط عام يخمّن الرمز (وكان تسلسلياً) ⇒ يشلّ كل عمّال العدّ الميدانيين (DoS تشغيلي).
    // الآن: لا قفل صفوف عند PIN خاطئ غير منسوب لتكليف؛ الحماية بالحدّ على IP (COUNT_RATE_LIMIT_MAX).
    const r = await mkPortalSession({
      assignments: [{ name: "عامل أ", method: "PIN", variantIds: [1, 2] }],
    });
    const aid = r.assignments[0].assignmentId;
    const pin = r.assignments[0].pin!;
    const wrong = wrongPinFor(pin);

    // ١٠ فشلات متتالية لا تقفل التكليف ولا تزيد العدّاد على الصفّ (الحماية بحدّ IP).
    for (let i = 0; i < 10; i++) {
      await expectTrpc(authenticatePin(null, { sessionCode: r.code, pin: wrong }), "UNAUTHORIZED");
    }
    const a = await assignmentRow(aid);
    expect(a.failedPinAttempts).toBe(0);
    expect(a.lockedUntil).toBeNull();

    // الرمز الصحيح ما زال يدخل بعد محاولات خاطئة كثيرة ⇒ لا حجب تشغيلي للعمّال الشرعيين.
    const auth = await authenticatePin(null, { sessionCode: r.code, pin });
    expect(auth.token).toBeTruthy();
  });

  it("قفل يدوي إداري على تكليف يظلّ يصدّ الرمز الصحيح ويُلغى بانقضاء lockedUntil", async () => {
    // القفل اليدوي (lockedUntil يُكتَب صراحةً من إدارة الجرد، لا من PIN خاطئ) يبقى مدعوماً.
    const r = await mkPortalSession({
      assignments: [{ name: "عامل أ", method: "PIN", variantIds: [1, 2] }],
    });
    const aid = r.assignments[0].assignmentId;
    const pin = r.assignments[0].pin!;

    // تثبيت قفل إداري ١٥د.
    await db()
      .update(s.stocktakeAssignments)
      .set({ lockedUntil: new Date(Date.now() + 15 * 60 * 1000) })
      .where(eq(s.stocktakeAssignments.id, aid));

    // كل تكليفات PIN مقفلة ⇒ رسالة قفل صريحة حتى مع الرمز الصحيح.
    await expectTrpc(authenticatePin(null, { sessionCode: r.code, pin }), "TOO_MANY_REQUESTS", /15 دقيقة/);

    // انقضاء القفل ⇒ الرمز الصحيح يدخل.
    await db()
      .update(s.stocktakeAssignments)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(s.stocktakeAssignments.id, aid));
    const auth = await authenticatePin(null, { sessionCode: r.code, pin });
    expect(auth.token).toBeTruthy();
  });
});

describe("الجرد الأعمى (state)", () => {
  it("شكل المخرج فعلياً: لا expectedQty ولا تكاليف، وعدّ الزميل يظهر «معدوداً» بلا كمية", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    const idB = await loginPin(r.code, r.assignments[1].pin!);

    await submit(idA, 1, 10, { unitBreakdown: '{"قطعة":10}' });

    // منظور ب: صنف الزميل معدود بلا كمية ولا اسم عادّ — وشكل العنصر مطابق للعقد حرفياً.
    const stateB = await getPortalState(idB);
    const item1 = stateB.items.find((i) => i.variantId === 1)!;
    expect(Object.keys(item1).sort()).toEqual([
      "colleagueCounted",
      "counted",
      "isMine",
      "myCount",
      "productName",
      "sku",
      "units",
      "variantId",
      "variantName",
    ]);
    expect(item1.isMine).toBe(false);
    expect(item1.counted).toBe(true);
    expect(item1.colleagueCounted).toBe(true);
    expect(item1.myCount).toBeNull();

    const jsonB = JSON.stringify(stateB);
    expect(jsonB).not.toMatch(/expectedQty|unitCost|costPrice|"price"/);
    // لا كمية زميل في أي عنصر (myCount=null للجميع لدى ب) ⇒ لا حقل qty إطلاقاً.
    expect(JSON.stringify(stateB.items)).not.toMatch(/"qty"/);
    expect(jsonB).not.toContain("عامل أ"); // اسم العادّ الزميل لا يصل

    // الوحدات بباركوداتها مرتّبة الكبرى أولاً (للمسح والإدخال متعدد الوحدات).
    expect(item1.units).toEqual([
      { unitName: "درزن", factor: 12, barcode: "BC-PEN-12" },
      { unitName: "قطعة", factor: 1, barcode: "BC-PEN-1" },
    ]);

    // منظور أ: يرى كميته هو فقط (myCount) مع تفصيل الوحدات.
    const stateA = await getPortalState(idA);
    const mine = stateA.items.find((i) => i.variantId === 1)!;
    expect(mine.isMine).toBe(true);
    expect(mine.myCount).toMatchObject({ qty: 10, unitBreakdown: '{"قطعة":10}' });
    expect(stateA.progress).toEqual({ mine: { counted: 1, total: 1 }, session: { counted: 1, total: 2 } });
    expect(stateA.session.code).toBe(r.code);
    expect(stateA.assignment.name).toBe("عامل أ");
  });

  it("مهمة إعادة العدّ تظهر للعامل، وعدّه التالي يُسجَّل RECOUNT ويُنجز الطلب", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    await submit(idA, 1, 10);

    await requestStocktakeRecount({ sessionId: r.sessionId, variantId: 1, reason: "فرق كبير عن المتوقع" }, actor);
    const stateA = await getPortalState(idA);
    expect(stateA.recountTasks).toEqual([
      { variantId: 1, productName: "قلم جاف", variantName: null, reason: "فرق كبير عن المتوقع" },
    ]);

    const res = await submit(idA, 1, 12);
    expect(res.kind).toBe("RECOUNT");
    const item = (
      await db()
        .select()
        .from(s.stocktakeItems)
        .where(and(eq(s.stocktakeItems.sessionId, r.sessionId), eq(s.stocktakeItems.variantId, 1)))
    )[0];
    expect(item.recountStatus).toBe("DONE");

    const rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    const row = rv.rows.find((x) => x.variantId === 1)!;
    expect(row.rawCount).toBe(12);
    expect(row.kindUsed).toBe("RECOUNT");
    expect(rv.barriers.pendingRecounts).toBe(0);
  });
});

describe("تسجيل العدّات (submit)", () => {
  it("النطاق: صنف خارج أصناف الجلسة يُرفض ولا يُكتب شيء", async () => {
    const r = await mkPortalSession(); // النطاق {1,2} — الصنف 3 موجود في النظام لكنه خارج الجلسة
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    await expectTrpc(submit(idA, 3, 7), "NOT_FOUND", /خارج نطاق/);
    await expectTrpc(submit(idA, 9999, 7), "NOT_FOUND");
    expect(await db().select().from(s.stocktakeCounts).where(eq(s.stocktakeCounts.sessionId, r.sessionId))).toHaveLength(0);
  });

  it("تحديث FIRST الذاتي: لا يكرّر صفاً — نفس الصف تتحدّث كميته", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);

    const r1 = await submit(idA, 1, 5);
    expect(r1).toMatchObject({ kind: "FIRST", idempotent: false });
    const r2 = await submit(idA, 1, 8);
    expect(r2).toMatchObject({ kind: "FIRST", idempotent: false });

    const rows = await countRowsOf(r.sessionId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("FIRST");
    expect(rows[0].qty).toBe(8);
  });

  it("idempotency: تكرار نفس clientRequestId ⇒ نجاح بلا أثر والكمية الأولى تبقى", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    const rid = randomUUID();

    const first = await submit(idA, 1, 7, { rid });
    expect(first).toMatchObject({ kind: "FIRST", idempotent: false });
    // إعادة إرسال (مزامنة أوفلاين مكرّرة) حتى بكمية مختلفة ⇒ لا أثر.
    const replay = await submit(idA, 1, 99, { rid });
    expect(replay).toMatchObject({ kind: "FIRST", idempotent: true });

    const rows = await countRowsOf(r.sessionId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(7);
  });

  it("dupPolicy=BLOCK: عدّ صنف زميل مرفوض برسالة واضحة ولا صفّ يُكتب", async () => {
    const r = await mkPortalSession({ dupPolicy: "BLOCK" });
    const idB = await loginPin(r.code, r.assignments[1].pin!);
    await expectTrpc(submit(idB, 1, 10), "CONFLICT", /منطقة زميلك/);
    expect(await countRowsOf(r.sessionId, 1)).toHaveLength(0);
    // وصنفه هو يُقبل طبيعياً.
    const own = await submit(idB, 2, 50);
    expect(own.kind).toBe("FIRST");
  });

  it("VERIFY: مطابق ⇒ توثيق بلا تعارض؛ مخالف ⇒ isConflict؛ والعدّ الثالث يمسح التعارض والسجل يحفظ الكل", async () => {
    const r = await mkPortalSession(); // dupPolicy الافتراضي VERIFY
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    const idB = await loginPin(r.code, r.assignments[1].pin!);

    await submit(idA, 1, 10);

    // عدّ تحقّقي مطابق ⇒ علامة موثوقية، لا تعارض.
    const match = await submit(idB, 1, 10);
    expect(match).toMatchObject({ kind: "VERIFY", verifyMatch: true });
    let rows = await countRowsOf(r.sessionId, 1);
    expect(rows).toHaveLength(2);
    expect(rows[1].isConflict).toBe(false);
    let rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    expect(rv.rows.find((x) => x.variantId === 1)!.verify).toMatchObject({ qty: 10, match: true });

    // تعديل العدّ التحقّقي لقيمة مخالفة ⇒ نفس الصف، isConflict=true، يحجب الاعتماد.
    // verifyMatch=null على التعديل (سدّ أوراكل استنتاج كمية الزميل بالتقريب) — التطابق يُكشف
    // لأول إرسال فقط؛ كشف التعارض الفعلي يبقى مُثبَتاً عبر isConflict والمراقبة والحواجز أدناه.
    const mismatch = await submit(idB, 1, 12);
    expect(mismatch).toMatchObject({ kind: "VERIFY", verifyMatch: null });
    rows = await countRowsOf(r.sessionId, 1);
    expect(rows).toHaveLength(2); // لا صفّ ثالثاً — تحديث للتحقّقي نفسه
    expect(rows[1].isConflict).toBe(true);
    expect((await monitorStocktakeSession(r.sessionId)).conflicts).toHaveLength(1);
    rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    expect(rv.barriers.openConflicts).toBe(1);
    expect(rv.rows.find((x) => x.variantId === 1)!.conflict).toMatchObject({
      qty1: 10,
      by1: "عامل أ",
      qty2: 12,
      by2: "عامل ب",
      resolvedPick: null,
    });

    // طلب إعادة عدّ ⇒ العدّ الثالث (RECOUNT) يحسم: يمسح التعارض ويصبح هو rawCount.
    await requestStocktakeRecount({ sessionId: r.sessionId, variantId: 1, reason: "تعارض عدَّين" }, actor);
    const third = await submit(idA, 1, 11);
    expect(third.kind).toBe("RECOUNT");

    rows = await countRowsOf(r.sessionId, 1);
    expect(rows).toHaveLength(3); // FIRST + VERIFY + RECOUNT — العدّات تبقى موثَّقة دائماً
    expect(rows.map((x) => x.kind).sort()).toEqual(["FIRST", "RECOUNT", "VERIFY"]);
    expect(rows.every((x) => !x.isConflict)).toBe(true);

    rv = await computeStocktakeReview(r.sessionId, { viewerId: 1 });
    const row = rv.rows.find((x) => x.variantId === 1)!;
    expect(row.rawCount).toBe(11);
    expect(row.kindUsed).toBe("RECOUNT");
    expect(row.conflict).toBeNull();
    expect(rv.barriers.openConflicts).toBe(0);
    expect((await monitorStocktakeSession(r.sessionId)).conflicts).toHaveLength(0);
  });

  it("VERIFY على صنف زميل لم يُعدّ بعد ⇒ يُسجَّل FIRST باسمي (لا تحقّقي بلا أصل)", async () => {
    const r = await mkPortalSession();
    const idB = await loginPin(r.code, r.assignments[1].pin!);
    const res = await submit(idB, 1, 33); // صنف أ، لا FIRST بعد
    expect(res.kind).toBe("FIRST");
    const rows = await countRowsOf(r.sessionId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].countedByName).toBe("عامل ب");
  });
});

describe("التسليم (finish)", () => {
  it("آخر تكليف يُسلَّم ينقل الجلسة REVIEW؛ وبعد التسليم لا عدّ ولا دخول جديد", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    // ب يحتفظ بتوكنه لإعادة حلّ هويته بعد REVIEW (كما يفعل الراوتر في كل طلب).
    const authB = await authenticatePin(null, { sessionCode: r.code, pin: r.assignments[1].pin! });
    const idB: PortalIdentity = {
      session: authB.session,
      assignment: authB.assignment,
      countedByName: authB.assignment.name,
      countedByUserId: null,
      mode: "PIN",
    };
    await submit(idA, 1, 10);
    await submit(idB, 2, 50);

    // تسليم أ: الجلسة ما زالت قيد العدّ.
    const f1 = await finishAssignment(idA);
    expect(f1).toMatchObject({ ok: true, sessionMovedToReview: false, alreadySubmitted: false });
    let sess = (await db().select().from(s.stocktakeSessions).where(eq(s.stocktakeSessions.id, r.sessionId)))[0];
    expect(sess.status).toBe("COUNTING");

    // أ سلّم ⇒ لا يعدّل عدّاته بعد التسليم.
    await expectTrpc(submit(idA, 1, 11), "BAD_REQUEST", /سلّمت/);

    // تسليم ب (الأخير) ⇒ الجلسة REVIEW آلياً مع submittedAt.
    const f2 = await finishAssignment(idB);
    expect(f2).toMatchObject({ ok: true, sessionMovedToReview: true });
    sess = (await db().select().from(s.stocktakeSessions).where(eq(s.stocktakeSessions.id, r.sessionId)))[0];
    expect(sess.status).toBe("REVIEW");
    expect(sess.submittedAt).not.toBeNull();
    const asgs = await db().select().from(s.stocktakeAssignments).where(eq(s.stocktakeAssignments.sessionId, r.sessionId));
    expect(asgs.every((a) => a.status === "SUBMITTED")).toBe(true);

    // إعادة التسليم idempotent، والعدّ بعد انتهاء مرحلة العدّ مرفوض، والدخول الجديد مرفوض.
    const f3 = await finishAssignment(idB);
    expect(f3).toMatchObject({ ok: true, sessionMovedToReview: false, alreadySubmitted: true });
    await expectTrpc(submit(idB, 2, 51), "BAD_REQUEST");
    await expectTrpc(authenticatePin(null, { sessionCode: r.code, pin: r.assignments[0].pin! }), "NOT_FOUND");

    // state يبقى متاحاً بعد REVIEW (يعرض «سلّمت العدّ»): الهوية تُحلّ من الكوكي في كل طلب
    // (نفس مسار الراوتر) فتأتي حالة الجلسة/التكليف طازجة من القاعدة.
    const freshB = await resolvePortalIdentity(
      { req: { headers: { cookie: `${COUNT_COOKIE_NAME}=${authB.token}` } }, user: null } as any,
      r.code
    );
    const stateB = await getPortalState(freshB);
    expect(stateB.session.status).toBe("REVIEW");
    expect(stateB.assignment.status).toBe("SUBMITTED");
  });
});
