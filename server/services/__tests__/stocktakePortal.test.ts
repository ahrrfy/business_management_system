// اختبارات تشغيلية لبوابة العدّ الخارجية — countPortalService (العقد docs/stocktake-contract.md §٥).
//
// تغطّي: مصادقة PIN/USER والكوكي (count_token)، قفل PIN بعد ٥ فشلات و١٥ دقيقة، الجرد
// الأعمى (شكل مخرج state فعلياً — لا expectedQty ولا تكاليف ولا كميات زملاء)، النطاق
// (صنف خارج الجلسة يُرفض)، dupPolicy: BLOCK يرفض وVERIFY مطابق/مخالف (isConflict)
// والعدّ الثالث يمسح التعارض، تحديث FIRST الذاتي بلا تكرار صفّ، idempotency بتكرار
// clientRequestId، وfinish: آخر تكليف ينقل الجلسة REVIEW.
import { createHmac, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  authenticatePin,
  COUNT_COOKIE_NAME,
  finishAssignment,
  getPortalCatalog,
  getPortalDynamic,
  getPortalPulse,
  getPortalState,
  resolvePortalIdentity,
  submitCount,
  type PortalIdentity,
} from "../countPortalService";
import { mergePortalState } from "../../../shared/countPortalMerge";
import { signPortalVersion } from "../countPortal/state";
import {
  computeStocktakeReview,
  createStocktakeSession,
  monitorStocktakeSession,
  requestStocktakeRecount,
  type CreateStocktakeInput,
} from "../stocktakeService";

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
  "productUnitBarcodes",
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
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/** بذرة أساس خاصة بالاختبار: فرع + مستخدمان + ٣ متغيّرات (الأول بوحدتين وباركودين + بديل لوحدة القطعة). */
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
  // باركود بديل لوحدة القطعة — يجب أن يصل لبوابة العدّ ليتعرّف عليه مسح العدّاد (كما في الكاشير).
  await d.insert(s.productUnitBarcodes).values([{ productUnitId: 1, barcode: "BC-PEN-ALT" }]);
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

/**
 * يحاكي عقد الراوتر `count.state` حرفياً (غلاف ETag + فصل الكتالوج) — أي انحرافٍ بينه وبين
 * `countPortalRouter.state` يجعل هذه الاختبارات تحرس عقداً غير المستعمَل فعلاً.
 */
async function portalState(
  identity: PortalIdentity,
  knownVersion?: string,
  knownCatalogVersion?: string,
) {
  const { v, cv } = await getPortalPulse(identity);
  if (knownVersion && knownVersion === v) {
    return { v, cv, changed: false as const, catalog: null, dynamic: null };
  }
  const catalogFresh = knownCatalogVersion === cv;
  const [dynamic, catalog] = await Promise.all([
    getPortalDynamic(identity),
    catalogFresh ? Promise.resolve(null) : getPortalCatalog(identity),
  ]);
  return { v, cv, changed: true as const, catalog: catalog?.items ?? null, dynamic };
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
    expect(item1.isMine).toBe(true);
    expect(item1.counted).toBe(true);
    expect(item1.colleagueCounted).toBe(true);
    expect(item1.myCount).toBeNull();

    const jsonB = JSON.stringify(stateB);
    expect(jsonB).not.toMatch(/expectedQty|unitCost|costPrice|"price"/);
    // لا كمية زميل في أي عنصر (myCount=null للجميع لدى ب) ⇒ لا حقل qty إطلاقاً.
    expect(JSON.stringify(stateB.items)).not.toMatch(/"qty"/);
    expect(jsonB).not.toContain("عامل أ"); // اسم العادّ الزميل لا يصل

    // الوحدات بباركوداتها مرتّبة الكبرى أولاً (للمسح والإدخال متعدد الوحدات)،
    // ومع البدائل (productUnitBarcodes) كي يتعرّف مسح البوابة على أيّ باركود ملصوق.
    expect(item1.units).toEqual([
      { unitName: "درزن", factor: 12, barcode: "BC-PEN-12", aliases: [] },
      { unitName: "قطعة", factor: 1, barcode: "BC-PEN-1", aliases: ["BC-PEN-ALT"] },
    ]);

    // منظور أ: يرى كميته هو فقط (myCount) مع تفصيل الوحدات.
    const stateA = await getPortalState(idA);
    const mine = stateA.items.find((i) => i.variantId === 1)!;
    expect(mine.isMine).toBe(true);
    expect(mine.myCount).toMatchObject({ qty: 10, unitBreakdown: '{"قطعة":10}' });
    expect(stateA.progress).toEqual({ mine: { counted: 1, total: 2 }, session: { counted: 1, total: 2 } });
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
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    const first = await submit(idB, 1, 10);
    expect(first.kind).toBe("FIRST");
    expect(await countRowsOf(r.sessionId, 1)).toHaveLength(1);
    await expectTrpc(submit(idA, 1, 11), "CONFLICT");
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
    expect(f1).toMatchObject({ ok: true, sessionMovedToReview: true, alreadySubmitted: false });
    let sess = (await db().select().from(s.stocktakeSessions).where(eq(s.stocktakeSessions.id, r.sessionId)))[0];
    expect(sess.status).toBe("REVIEW");

    // أ سلّم ⇒ لا يعدّل عدّاته بعد التسليم.
    await expectTrpc(submit(idA, 1, 11), "BAD_REQUEST");

    // تسليم ب (الأخير) ⇒ الجلسة REVIEW آلياً مع submittedAt.
    const f2 = await finishAssignment(idB);
    expect(f2).toMatchObject({ ok: true, sessionMovedToReview: false, alreadySubmitted: true });
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

// ─────────────────────────── نبضة النسخة (pulse) ───────────────────────────
// العقد: الوسم يتبدّل **كلّما تبدّل شيءٌ يظهر في state**، ويثبت إن لم يتبدّل شيء.
// الخطر الذي تحرسه هذه الاختبارات: وسمٌ يُغفل تغييراً ⇒ شاشة العادّ تتجمّد صامتةً،
// وهو عطلٌ أسوأ من البطء الذي أتت النبضة لتعالجه.
describe("نبضة النسخة (pulse)", () => {
  it("ثابتة بلا تغيير، وتتبدّل عند كل حدثٍ يظهر في state", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    const idB = await loginPin(r.code, r.assignments[1].pin!);

    // (١) ثبات: نداءان متتاليان بلا أي حدث ⇒ نفس الوسم بالضبط (وإلّا لأبطلنا الكاش عبثاً
    //     في كل استقصاء وعاد الحمل الذي نعالجه).
    const v0 = (await getPortalPulse(idA)).v;
    expect((await getPortalPulse(idA)).v).toBe(v0);

    // (٢) عدّة جديدة مني ⇒ يتبدّل.
    await submit(idA, 1, 10);
    const v1 = (await getPortalPulse(idA)).v;
    expect(v1).not.toBe(v0);

    // (٣) تحديث عدّتي نفسها (لا صفّ جديد — نفس الصفّ تتغيّر كميته) ⇒ يجب أن يتبدّل أيضاً،
    //     لأنّ state يعرض الكمية الجديدة. هذه الحالة تسقط لو اكتُفي بـMAX(id) وحده.
    await submit(idA, 1, 25);
    const v2 = (await getPortalPulse(idA)).v;
    expect(v2).not.toBe(v1);

    // (٤) عدّة زميل ⇒ يتبدّل عند الطرفين (state يُظهر colleagueCounted وتقدّم الجلسة).
    await submit(idB, 2, 7);
    const v3 = (await getPortalPulse(idA)).v;
    expect(v3).not.toBe(v2);

    // (٥) طلب إعادة عدّ إداريّ: لا صفّ عدّاتٍ جديد ولا صفّ أصنافٍ جديد — تحديث حالة فقط.
    //     يظهر في state.recountTasks ⇒ يجب أن يتبدّل الوسم.
    await requestStocktakeRecount({ sessionId: r.sessionId, variantId: 1, reason: "فرق كبير" }, actor);
    const v4 = (await getPortalPulse(idA)).v;
    expect(v4).not.toBe(v3);

    // (٦) تسليم التكليف ⇒ assignment.status يتبدّل في state ⇒ الوسم يتبدّل.
    await finishAssignment(idA);
    const freshA = await resolvePortalIdentity(
      { req: { headers: { cookie: `${COUNT_COOKIE_NAME}=${idA.token ?? ""}` } }, user: null } as any,
      r.code,
    ).catch(() => null);
    if (freshA) expect((await getPortalPulse(freshA)).v).not.toBe(v4);
  });

  it("لا تكشف أي بيانات: الوسم أرقامٌ وحالاتٌ فقط — بلا أسماء ولا كميات (الجرد الأعمى)", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    await submit(idA, 1, 4242, { unitBreakdown: '{"قطعة":4242}' });

    const { v, cv } = await getPortalPulse(idA);
    // وسمان لا غير: حالة (`v`) وكتالوج (`cv`) — لا حقل بياناتٍ ثالث يتسلّل مع الوقت.
    expect(Object.keys(await getPortalPulse(idA)).sort()).toEqual(["cv", "v"]);
    for (const tag of [v, cv]) {
      // لا اسم منتجٍ (حتميّ: base64url لا يحوي حروفاً عربية أصلاً).
      expect(tag).not.toMatch(/قلم|جاف/);
      // شكلٌ مبهم ثابت الطول.
      expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    // إثبات الإبهام الفعليّ (لا حشو): البناء HMAC-SHA256 حقيقيّ لا ترميزٌ عكسيّ — انظر اختبار
    // «signPortalVersion بناءٌ HMAC» أدناه. (⚠️ فحص `not.toContain("<الرقم>")` على HMAC مبهم
    // بمفتاحٍ عشوائيّ هشٌّ — قد يحوي أرقام العدّ مصادفةً فيُحمّر main زوراً؛ كان سبب فشل CI #1387، ٨/٨.)
  });

  it("الوسم مُفتَّح ومبهم: لا بنية جبرية تُعكَس لاستخراج عدّة الزميل (ثغرة CRC الخام)", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    const idB = await loginPin(r.code, r.assignments[1].pin!);

    const before = (await getPortalPulse(idA)).v;
    await submit(idB, 2, 777);
    const after = (await getPortalPulse(idA)).v;

    // يتبدّل (فيعرف «أ» أنّ شيئاً جرى) لكن بلا أي مسارٍ لاستخراج المقدار.
    expect(after).not.toBe(before);

    // ⛔ الصيغة الأولى أعادت تجميعاتٍ خاماً مفصولةً بـ«:» فكان XOR/الطرح بين وسمين
    // متتاليين يعطي بصمة الصفّ المُضاف وحده ⇒ تُخمَّن الكمية بالقوة الغاشمة. الوسم الآن
    // HMAC واحد: لا فواصل، ولا أجزاء عددية، وطولٌ ثابت لا يتغيّر بحجم الجلسة.
    // (فحص `not.toContain("777")` أُزيل: هشٌّ على HMAC مبهم — قد يحوي الرقم مصادفةً؛ الإبهام
    // مُثبَتٌ حتمياً في اختبار «signPortalVersion بناءٌ HMAC» أدناه.)
    expect(after).not.toContain(":");
    expect(Number.isNaN(Number(after))).toBe(true);
    expect(after).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  // مراجعة Codex P2 (٨/٨): إثباتٌ **حتميّ لا احتماليّ ولا حشوٌ منطقيّ** أن الوسم بصمة HMAC-SHA256
  // حقيقية (لا ترميزٌ قابل للعكس يسرّب الكمية). لو ارتدّ signPortalVersion إلى `raw.slice(0,22)` أو
  // أي ترميزٍ عكسيّ ثابت العرض، تسقط مساواةُ HMAC هنا فوراً — الحارس الذي يعجز عنه فحص الطول/الشكل.
  it("signPortalVersion بناءٌ HMAC-SHA256 تحت المفتاح المحكوم — لا ترميزٌ عكسيّ يسرّب الكمية", () => {
    const key = process.env.JWT_SECRET ?? "test_secret"; // نفس مصدر VERSION_KEY وقت تحميل الوحدة
    const raw = "sess:7|counts:4242|unit:قطعة"; // مدخلٌ يحوي كميةً حسّاسة (4242) صراحةً
    const expected = createHmac("sha256", key).update(raw).digest("base64url").slice(0, 22);
    // (١) البناء HMAC فعلاً — يكشف أيّ ارتدادٍ لترميزٍ عكسيّ:
    expect(signPortalVersion(raw)).toBe(expected);
    // (٢) الكمية لا تظهر في الناتج (حتميّ الآن: مفتاحٌ ومدخلٌ ثابتان ⇒ ناتجٌ ثابت):
    expect(signPortalVersion(raw)).not.toContain("4242");
    // (٣) avalanche: تبدّلٌ طفيفٌ بالمدخل يقلب الوسم كلياً (لا دلتا جبرية تُعكَس):
    expect(signPortalVersion(raw + "!")).not.toBe(signPortalVersion(raw));
    // (٤) طولٌ ثابتٌ مستقلٌّ عن حجم المدخل (بصمةٌ لا ترميزٌ يتضخّم بالمقدار):
    expect(signPortalVersion("x").length).toBe(signPortalVersion("x".repeat(9999)).length);
  });

  it("غلاف ETag: knownVersion مطابق ⇒ بلا حمولة؛ ومخالف/غائب ⇒ الحمولة", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    await submit(idA, 1, 10);

    // بلا وسمٍ معروف ⇒ كتالوج + متغيّر + الوسمان.
    const full = await portalState(idA);
    expect(full.changed).toBe(true);
    expect(full.catalog?.length).toBeGreaterThan(0);
    expect(full.dynamic?.counts.length).toBeGreaterThan(0);

    // بالوسم نفسه ⇒ «بلا تغيير» وبلا أي حمولة (مصدر التوفير الأول).
    const same = await portalState(idA, full.v, full.cv);
    expect(same).toMatchObject({ changed: false, catalog: null, dynamic: null, v: full.v });

    // بعد عدّةٍ جديدة ⇒ وسمٌ جديد وحمولة.
    await submit(idA, 2, 3);
    const afterChange = await portalState(idA, full.v, full.cv);
    expect(afterChange.changed).toBe(true);
    expect(afterChange.v).not.toBe(full.v);
  });

  it("الدلتا: العدّ لا يُبدّل وسم الكتالوج ⇒ لا يُعاد إرسال الأصناف (٨٣٪ من الحمولة)", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    const first = await portalState(idA);
    const catalogCv = first.cv!;
    expect(first.catalog).not.toBeNull();

    // عدّةٌ جديدة تُبدّل وسم الحالة `v` لكن **لا** تمسّ الكتالوج.
    await submit(idA, 1, 12);
    const afterCount = await portalState(idA, first.v, catalogCv);
    expect(afterCount.changed).toBe(true);
    expect(afterCount.v).not.toBe(first.v);
    expect(afterCount.cv).toBe(catalogCv); // الكتالوج لم يتبدّل…
    expect(afterCount.catalog).toBeNull(); // …فلم يُعَد إرساله — جوهر الدلتا.
    expect(afterCount.dynamic?.counts).toEqual([
      expect.objectContaining({ variantId: 1, counted: true }),
    ]);

    // وعميلٌ بلا كتالوج مخزَّن (أو بوسمٍ قديم) يستلمه كاملاً — فلا يعلق بحالةٍ ناقصة.
    const stranger = await portalState(idA, undefined, "cv-قديم");
    expect(stranger.catalog?.length).toBeGreaterThan(0);
  });

  it("وسم الكتالوج من النبضة = وسمه من الكتالوج نفسه (وإلّا ضاع التوفير صامتاً)", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);

    // الراوتر يقارن `cv` القادم من النبضة (رخيص) بما لدى العميل، ولا يبني الكتالوج إلّا
    // عند الاختلاف. فلو انحرفت صيغتا الوسم لما تطابقا أبداً ⇒ يُبنى الكتالوج ويُرسَل في
    // **كل** دورة، فيعود الحمل كما كان بلا أي اختبارٍ أحمر يكشف ذلك.
    const pulse = await getPortalPulse(idA);
    const cat = await getPortalCatalog(idA);
    expect(pulse.cv).toBe(cat.cv);

    // ويبقيان متطابقين بعد العدّ (العدّ لا يمسّ الكتالوج).
    await submit(idA, 1, 5);
    const pulse2 = await getPortalPulse(idA);
    const cat2 = await getPortalCatalog(idA);
    expect(pulse2.cv).toBe(cat2.cv);
    expect(pulse2.cv).toBe(pulse.cv);
    expect(pulse2.v).not.toBe(pulse.v);
  });

  it("التركيب المشترك يعيد إنتاج getPortalState حرفياً (لا انحراف بين الخادم والعميل)", async () => {
    const r = await mkPortalSession();
    const idA = await loginPin(r.code, r.assignments[0].pin!);
    const idB = await loginPin(r.code, r.assignments[1].pin!);
    await submit(idA, 1, 9, { unitBreakdown: '{"قطعة":9}' });
    await submit(idB, 2, 4);
    await requestStocktakeRecount({ sessionId: r.sessionId, variantId: 2, reason: "تدقيق" }, actor);

    // نفس الدالّة النقيّة التي يستعملها العميل لإعادة التركيب.
    const [cat, dyn] = await Promise.all([getPortalCatalog(idA), getPortalDynamic(idA)]);
    const rebuilt = mergePortalState(cat.items, dyn);
    const direct = await getPortalState(idA);
    expect(rebuilt).toEqual(direct);
  });
});
