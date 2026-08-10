// «الجرد الافتتاحي» (الافتتاح التدريجي ١٨/٧) — ش٣: جلسة sessionType=OPENING بحوكمتها الكاملة:
// بوابات الإنشاء (مدير+/نافذة فعّالة/استبعاد المُفتتَح/حصر متبادل)، اعتماد بلا قيدَي عجز/زيادة
// بمرجع OPENING، ختم openedAt (حتى المعدود صفراً بلا صفّ)، توقيعان دائماً (إصلاح حاصرة التوقيع
// الأول)، SOD (منشئ≠معتمد، عادّ≠معتمد، admin مُستثنى)، الهدف السالب، وانحدار الجرد الدوري.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveStocktake,
  approveStocktakeItems,
  computeStocktakeReview,
  createStocktakeSession,
  firstSignStocktake,
  forceStocktakeReview,
} from "../stocktakeService";
import { cancelPurchaseOrder, createPurchaseOrder } from "../purchaseService";
import type { CreateStocktakeInput } from "../stocktake/create";

const ADMIN = { userId: 1, role: "admin" };
const MGR = { userId: 2, role: "manager" }; // منشئ الجلسات الافتتاحية في الاختبارات
const MGR2 = { userId: 3, role: "manager" }; // المعتمد الثاني
const WH = { userId: 4, role: "warehouse" };
const DAY_MS = 86_400_000;

const TABLES = [
  "stocktakeItemReviewEvents",
  "stocktakeDecisions",
  "stocktakeCountOperations",
  "stocktakeCounts",
  "stocktakeItems",
  "stocktakeAssignments",
  "stocktakeSessions",
  "openingModeSettings",
  "purchaseOrderItems",
  "purchaseOrders",
  "accountingEntries",
  "inventoryMovements",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "auditLogs",
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
    { id: 1, openId: "u_admin", name: "المدير العام", role: "admin", loginMethod: "local" },
    { id: 2, openId: "u_mgr", name: "مدير أول", role: "manager", loginMethod: "local" },
    { id: 3, openId: "u_mgr2", name: "مدير ثانٍ", role: "manager", loginMethod: "local" },
    { id: 4, openId: "u_wh", name: "أمين مخزن", role: "warehouse", loginMethod: "local" },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد الاختبار" });
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف" },
    { id: 2, name: "دفتر 100 ورقة" },
    { id: 3, name: "مسطرة" },
    { id: 4, name: "ممحاة" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "250.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "1500.00" },
    { id: 3, productId: 3, sku: "RUL-1", costPrice: "500.00" },
    { id: 4, productId: 4, sku: "ERS-1", costPrice: "250.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 4, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

async function enableOpeningMode(over: Partial<typeof s.openingModeSettings.$inferInsert> = {}) {
  await db()
    .insert(s.openingModeSettings)
    .values({ id: 1, enabled: true, endsAt: new Date(Date.now() + 7 * DAY_MS), maxNegativeQtyPerLine: 100, ...over });
}
async function expireOpeningWindow() {
  await db()
    .update(s.openingModeSettings)
    .set({ endsAt: new Date(Date.now() - DAY_MS) })
    .where(eq(s.openingModeSettings.id, 1));
}

async function mkOpening(over: Partial<CreateStocktakeInput> = {}, actor = MGR) {
  return createStocktakeSession(
    {
      name: "جرد افتتاحي اختباري",
      branchId: 1,
      sessionType: "OPENING",
      scopeType: "MANUAL",
      variantIds: [1, 2, 3],
      assignments: [{ name: "عامل أ", method: "PIN" }],
      ...over,
    },
    actor,
  );
}

async function insertCount(sessionId: number, variantId: number, assignmentId: number, qty: number, at?: Date) {
  await db().insert(s.stocktakeCounts).values({
    sessionId,
    variantId,
    assignmentId,
    kind: "FIRST",
    qty,
    countedByName: "عامل الاختبار",
    countedAt: at ?? new Date(Date.now() - 5_000),
    isConflict: false,
    clientRequestId: randomUUID(),
  });
}

async function approveAllReadyItems(sessionId: number, actor = MGR) {
  const review = await computeStocktakeReview(sessionId, { viewerId: actor.userId });
  const ids = review.rows.filter((r) => r.readyForReviewApproval && !r.reviewApproved?.isCurrent).map((r) => r.variantId);
  if (ids.length) await approveStocktakeItems({ sessionId, variantIds: ids }, actor);
}

async function firstAssignmentId(sessionId: number): Promise<number> {
  const [a] = await db()
    .select({ id: s.stocktakeAssignments.id })
    .from(s.stocktakeAssignments)
    .where(eq(s.stocktakeAssignments.sessionId, sessionId));
  return Number(a.id);
}

async function stockRow(variantId: number, branchId = 1) {
  const [r] = await db()
    .select()
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return r ?? null;
}

async function openingMovements(sessionId: number) {
  return db()
    .select()
    .from(s.inventoryMovements)
    .where(and(eq(s.inventoryMovements.referenceType, "OPENING"), eq(s.inventoryMovements.referenceId, sessionId)));
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

describe("بوابات إنشاء الجلسة الافتتاحية", () => {
  it("تُرفض والوضع مطفأ — القناة محصورة بنافذة الافتتاح", async () => {
    await expectTrpc(mkOpening(), "PRECONDITION_FAILED", /وضع الافتتاح غير فعّال/);
  });

  it("تُرفض من أمين المخزن حتى والنافذة فعّالة — نوع الجلسة قرار حوكمي لمدير فأعلى", async () => {
    await enableOpeningMode();
    await expectTrpc(mkOpening({}, WH), "FORBIDDEN", /مدير فأعلى/);
    // الجرد الدوري يبقى من صلاحياته كما هو.
    const normal = await createStocktakeSession(
      {
        name: "دوري",
        branchId: 1,
        scopeType: "MANUAL",
        variantIds: [1],
        assignments: [{ name: "عامل", method: "PIN" }],
      },
      WH,
    );
    expect(normal.sessionId).toBeGreaterThan(0);
  });

  it("MANUAL بصنف مُفتتَح يُرفض ناطقاً؛ وFULL يستبعد المُفتتَح تلقائياً", async () => {
    await enableOpeningMode();
    // افتتاح الصنف ١ مسبقاً.
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 10, openedAt: new Date() });
    await expectTrpc(mkOpening({ variantIds: [1, 2] }), "BAD_REQUEST", /سبق افتتاحها/);

    const res = await mkOpening({ scopeType: "FULL", variantIds: undefined });
    // FULL على ٤ متغيّرات − المُفتتَح (١) = ٣.
    expect(res.itemCount).toBe(3);
    const inScope = await db()
      .select({ variantId: s.stocktakeItems.variantId })
      .from(s.stocktakeItems)
      .where(eq(s.stocktakeItems.sessionId, res.sessionId));
    expect(inScope.map((r) => Number(r.variantId)).sort()).toEqual([2, 3, 4]);
  });

  it("المشتريات: MANUAL يرفض المرتبط في الفرع؛ وFULL يستبعده فقط إذا كان الأمر غير ملغى وفي الفرع نفسه", async () => {
    await enableOpeningMode();
    await db().insert(s.purchaseOrders).values([
      {
        id: 101,
        poNumber: "PO-OPEN-SAME-BRANCH",
        supplierId: 1,
        branchId: 1,
        subtotal: "100.00",
        total: "100.00",
        status: "DRAFT",
        createdBy: 1,
      },
      {
        id: 102,
        poNumber: "PO-OPEN-OTHER-BRANCH",
        supplierId: 1,
        branchId: 2,
        subtotal: "100.00",
        total: "100.00",
        status: "DRAFT",
        createdBy: 1,
      },
      {
        id: 103,
        poNumber: "PO-OPEN-CANCELLED",
        supplierId: 1,
        branchId: 1,
        subtotal: "100.00",
        total: "100.00",
        status: "CANCELLED",
        createdBy: 1,
      },
    ]);
    await db().insert(s.purchaseOrderItems).values([
      { purchaseOrderId: 101, variantId: 1, quantity: "1", baseQuantity: 1, unitPrice: "100.00", total: "100.00" },
      { purchaseOrderId: 102, variantId: 2, quantity: "1", baseQuantity: 1, unitPrice: "100.00", total: "100.00" },
      { purchaseOrderId: 103, variantId: 3, quantity: "1", baseQuantity: 1, unitPrice: "100.00", total: "100.00" },
    ]);

    await expectTrpc(mkOpening({ variantIds: [1] }), "BAD_REQUEST", /فاتورة مشتريات|أمر شراء|مرتبطة.*مشتريات/);

    const res = await mkOpening({ scopeType: "FULL", variantIds: undefined });
    expect(res.itemCount).toBe(3);
    const inScope = await db()
      .select({ variantId: s.stocktakeItems.variantId })
      .from(s.stocktakeItems)
      .where(eq(s.stocktakeItems.sessionId, res.sessionId));
    // ١ مرتبط بـDRAFT في الفرع نفسه فيُستبعد؛ ٢ مشتراه في فرع آخر و٣ أمره ملغى فيبقيان مؤهلَين.
    expect(inScope.map((r) => Number(r.variantId)).sort()).toEqual([2, 3, 4]);
  });

  it("إنشاء قائمة شراء أثناء جلسة افتتاحية نشطة يزيل الصنف وعدّه فوراً", async () => {
    await enableOpeningMode();
    const session = await mkOpening({ variantIds: [1] });
    const assignmentId = await firstAssignmentId(session.sessionId);
    await insertCount(session.sessionId, 1, assignmentId, 7);

    await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "100.00" }],
      },
      { userId: 1, branchId: 1 },
    );

    const [items, counts] = await Promise.all([
      db().select().from(s.stocktakeItems).where(eq(s.stocktakeItems.sessionId, session.sessionId)),
      db().select().from(s.stocktakeCounts).where(eq(s.stocktakeCounts.sessionId, session.sessionId)),
    ]);
    expect(items).toHaveLength(0);
    expect(counts).toHaveLength(0);
  });

  it("إلغاء قائمة الشراء يعيد الصنف إلى نطاق MANUAL النشط بلقطة الرصيد والتكلفة الحالية", async () => {
    await enableOpeningMode();
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 5 });
    const session = await mkOpening({ variantIds: [1] });
    const assignmentId = await firstAssignmentId(session.sessionId);

    const po = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "100.00" }],
      },
      { userId: ADMIN.userId, branchId: 1 },
    );
    expect(
      await db().select().from(s.stocktakeItems).where(eq(s.stocktakeItems.sessionId, session.sessionId)),
    ).toHaveLength(0);

    await db().update(s.branchStock).set({ quantity: 19 }).where(
      and(eq(s.branchStock.branchId, 1), eq(s.branchStock.variantId, 1)),
    );
    await db().update(s.productVariants).set({ costPrice: "333.00" }).where(eq(s.productVariants.id, 1));
    await cancelPurchaseOrder(po.purchaseOrderId, { userId: ADMIN.userId, branchId: 1 });

    const [restored] = await db()
      .select()
      .from(s.stocktakeItems)
      .where(eq(s.stocktakeItems.sessionId, session.sessionId));
    expect(Number(restored.variantId)).toBe(1);
    expect(Number(restored.assignmentId)).toBe(assignmentId);
    expect(restored.expectedQty).toBe(19);
    expect(restored.unitCost).toBe("333.00");
  });

  it("إلغاء قائمة لا يعيد الصنف ما دام مرتبطاً بقائمة شراء أخرى غير ملغاة", async () => {
    await enableOpeningMode();
    const session = await mkOpening({ variantIds: [1] });
    const makePo = () => createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT" as const,
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "100.00" }],
      },
      { userId: ADMIN.userId, branchId: 1 },
    );
    const first = await makePo();
    const second = await makePo();

    await cancelPurchaseOrder(first.purchaseOrderId, { userId: ADMIN.userId, branchId: 1 });
    expect(
      await db().select().from(s.stocktakeItems).where(eq(s.stocktakeItems.sessionId, session.sessionId)),
    ).toHaveLength(0);

    await cancelPurchaseOrder(second.purchaseOrderId, { userId: ADMIN.userId, branchId: 1 });
    const restored = await db()
      .select({ variantId: s.stocktakeItems.variantId })
      .from(s.stocktakeItems)
      .where(eq(s.stocktakeItems.sessionId, session.sessionId));
    expect(restored.map((row) => Number(row.variantId))).toEqual([1]);
  });

  it("إلغاء القائمة يعيد جلسة REVIEW المتأثرة إلى COUNTING ويفتح تكليفاتها", async () => {
    await enableOpeningMode();
    const session = await mkOpening({ variantIds: [1] });
    const assignmentId = await firstAssignmentId(session.sessionId);
    const signedAt = new Date();
    await db()
      .update(s.stocktakeAssignments)
      .set({ status: "SUBMITTED", submittedAt: signedAt })
      .where(eq(s.stocktakeAssignments.id, assignmentId));
    await db()
      .update(s.stocktakeSessions)
      .set({ status: "REVIEW", submittedAt: signedAt, firstSignBy: MGR.userId, firstSignAt: signedAt })
      .where(eq(s.stocktakeSessions.id, session.sessionId));

    const po = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "100.00" }],
      },
      { userId: ADMIN.userId, branchId: 1 },
    );
    await cancelPurchaseOrder(po.purchaseOrderId, { userId: ADMIN.userId, branchId: 1 });

    const [sessionRow] = await db()
      .select({
        status: s.stocktakeSessions.status,
        submittedAt: s.stocktakeSessions.submittedAt,
        firstSignBy: s.stocktakeSessions.firstSignBy,
        firstSignAt: s.stocktakeSessions.firstSignAt,
      })
      .from(s.stocktakeSessions)
      .where(eq(s.stocktakeSessions.id, session.sessionId));
    expect(sessionRow).toMatchObject({
      status: "COUNTING",
      submittedAt: null,
      firstSignBy: null,
      firstSignAt: null,
    });

    const [assignment] = await db()
      .select({ status: s.stocktakeAssignments.status, submittedAt: s.stocktakeAssignments.submittedAt })
      .from(s.stocktakeAssignments)
      .where(eq(s.stocktakeAssignments.id, assignmentId));
    expect(assignment).toMatchObject({ status: "ACTIVE", submittedAt: null });
    expect(
      await db().select().from(s.stocktakeItems).where(eq(s.stocktakeItems.sessionId, session.sessionId)),
    ).toHaveLength(1);
  });

  it("تنظيف مشتريات جلسة REVIEW يحذف التوابع ويُبطل التوقيع الأول", async () => {
    await enableOpeningMode();
    const session = await mkOpening({ variantIds: [1] });
    const assignmentId = await firstAssignmentId(session.sessionId);
    await insertCount(session.sessionId, 1, assignmentId, 7);

    const operationId = 7_001;
    const snapshotHash = "a".repeat(64);
    const signedAt = new Date();
    await db().insert(s.stocktakeCountOperations).values({
      id: operationId,
      sessionId: session.sessionId,
      variantId: 1,
      assignmentId,
      clientRequestId: randomUUID(),
      requestQty: 7,
      resultKind: "FIRST",
    });
    await db()
      .update(s.stocktakeItems)
      .set({
        reviewApprovedBy: MGR.userId,
        reviewApprovedAt: signedAt,
        reviewApprovedOperationId: operationId,
        reviewApprovedQty: 7,
        reviewApprovedSnapshotHash: snapshotHash,
      })
      .where(
        and(
          eq(s.stocktakeItems.sessionId, session.sessionId),
          eq(s.stocktakeItems.variantId, 1),
        ),
      );
    await db().insert(s.stocktakeItemReviewEvents).values({
      sessionId: session.sessionId,
      variantId: 1,
      action: "APPROVE",
      snapshotOperationId: operationId,
      snapshotQty: 7,
      snapshotHash,
      actedBy: MGR.userId,
    });
    await db().insert(s.stocktakeDecisions).values({
      sessionId: session.sessionId,
      variantId: 1,
      action: "KEEP",
      finalQty: 7,
      diffQty: 7,
      value: "1750.00",
      decidedBy: MGR.userId,
    });
    await db()
      .update(s.stocktakeAssignments)
      .set({ status: "SUBMITTED", submittedAt: signedAt })
      .where(eq(s.stocktakeAssignments.id, assignmentId));
    await db()
      .update(s.stocktakeSessions)
      .set({
        status: "REVIEW",
        submittedAt: signedAt,
        firstSignBy: MGR.userId,
        firstSignAt: signedAt,
      })
      .where(eq(s.stocktakeSessions.id, session.sessionId));

    await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "1",
            unitPrice: "100.00",
          },
        ],
      },
      { userId: ADMIN.userId, branchId: 1 },
    );

    const [sessionRow] = await db()
      .select({
        status: s.stocktakeSessions.status,
        firstSignBy: s.stocktakeSessions.firstSignBy,
        firstSignAt: s.stocktakeSessions.firstSignAt,
      })
      .from(s.stocktakeSessions)
      .where(eq(s.stocktakeSessions.id, session.sessionId));
    expect(sessionRow.status).toBe("REVIEW");
    expect(sessionRow.firstSignBy).toBeNull();
    expect(sessionRow.firstSignAt).toBeNull();

    const [items, counts, operations, decisions, reviewEvents] = await Promise.all([
      db().select().from(s.stocktakeItems).where(eq(s.stocktakeItems.sessionId, session.sessionId)),
      db().select().from(s.stocktakeCounts).where(eq(s.stocktakeCounts.sessionId, session.sessionId)),
      db()
        .select()
        .from(s.stocktakeCountOperations)
        .where(eq(s.stocktakeCountOperations.sessionId, session.sessionId)),
      db()
        .select()
        .from(s.stocktakeDecisions)
        .where(eq(s.stocktakeDecisions.sessionId, session.sessionId)),
      db()
        .select()
        .from(s.stocktakeItemReviewEvents)
        .where(eq(s.stocktakeItemReviewEvents.sessionId, session.sessionId)),
    ]);
    for (const rows of [items, counts, operations, decisions, reviewEvents]) {
      expect(rows).toHaveLength(0);
    }
  });

  it("كل النطاق مُفتتَح ⇒ رفض برسالة واضحة", async () => {
    await enableOpeningMode();
    const now = new Date();
    await db()
      .insert(s.branchStock)
      .values([1, 2, 3, 4].map((v) => ({ variantId: v, branchId: 1, quantity: 5, openedAt: now })));
    await expectTrpc(
      mkOpening({ scopeType: "FULL", variantIds: undefined }),
      "BAD_REQUEST",
      /كل أصناف النطاق مستبعَدة.*مُفتتَحة/,
    );
  });

  it("الحصر المتبادل: جلسة نشطة تمنع الافتتاحية والعكس — وفرع آخر لا يتأثر", async () => {
    await enableOpeningMode();
    const normal = await createStocktakeSession(
      { name: "دوري", branchId: 1, scopeType: "MANUAL", variantIds: [4], assignments: [{ name: "ع", method: "PIN" }] },
      MGR,
    );
    await expectTrpc(mkOpening(), "CONFLICT", /جلسة جرد نشطة/);

    // الفرع الآخر حرّ.
    const other = await mkOpening({ branchId: 2, scopeType: "MANUAL", variantIds: [1, 2] });
    expect(other.sessionId).toBeGreaterThan(0);

    // وأثناء الافتتاحية النشطة (فرع ٢) لا تُنشأ جلسة أخرى عليه.
    await expectTrpc(
      createStocktakeSession(
        { name: "دوري٢", branchId: 2, scopeType: "MANUAL", variantIds: [3], assignments: [{ name: "ع", method: "PIN" }] },
        MGR,
      ),
      "CONFLICT",
      /جلسة جرد افتتاحي نشطة/,
    );
    void normal;
  });
});

describe("اعتماد الجلسة الافتتاحية — المسار الذهبي", () => {
  it("حركات OPENING بمرجع الجلسة + صفر قيود دفتر + openedAt للجميع (حتى المعدود صفراً بلا صفّ) + توقيعان", async () => {
    await enableOpeningMode();
    // الصنف ٣ عليه رصيد دفتري قديم ١٠ (أُدخل يدوياً بلا افتتاح) — العدّ ٧ يصحّحه بلا أي قيد.
    await db().insert(s.branchStock).values({ variantId: 3, branchId: 1, quantity: 10 });

    const res = await mkOpening(); // [1,2,3] بمنشئ MGR
    const aid = await firstAssignmentId(res.sessionId);
    await insertCount(res.sessionId, 1, aid, 20);
    await insertCount(res.sessionId, 2, aid, 0); // عُدّ صفراً — لا صفّ branchStock له أصلاً
    await insertCount(res.sessionId, 3, aid, 7);
    await forceStocktakeReview(res.sessionId, MGR);
    await approveAllReadyItems(res.sessionId, MGR);

    // (الحاصرة المُصلَحة) التوقيع الأول يُقبل رغم أن كل القيم تحت dualThreshold.
    await firstSignStocktake(res.sessionId, MGR);
    // الاعتماد بلا توقيع أول مرفوض — جُرِّب بمستخدم آخر قبل التوقيع في جلسة ثانية أدناه؛ هنا نعتمد.
    const approved = await approveStocktake(res.sessionId, MGR2);
    expect(approved.ok).toBe(true);
    expect(approved.shortExpense).toBe("0.00");
    expect(approved.overGain).toBe("0.00");

    // الأرصدة = العدّ.
    expect((await stockRow(1))?.quantity).toBe(20);
    expect((await stockRow(2))?.quantity).toBe(0);
    expect((await stockRow(3))?.quantity).toBe(7);

    // openedAt للجميع — بما فيهم المعدود صفراً (أُنشئ صفّه upsert).
    for (const v of [1, 2, 3]) expect((await stockRow(v))?.openedAt).not.toBeNull();
    for (const v of [1, 2, 3]) expect((await stockRow(v))?.lastCountedAt).not.toBeNull();

    // حركات بمرجع OPENING + referenceId = الجلسة (لإعادة بناء «من فتتح» ولاستبعاد netAfter).
    const moves = await openingMovements(res.sessionId);
    // الصنف ٢ عُدّ صفراً على رصيد صفر ⇒ diff=0 ⇒ KEEP بلا حركة؛ ١ و٣ تسويتان.
    expect(moves.length).toBe(2);

    // صفر قيود دفتر إطلاقاً (لا ADJUST ولا غيره).
    const entries = await db().select().from(s.accountingEntries);
    expect(entries.length).toBe(0);

    // idempotent: إعادة الاعتماد بلا أثر مضاعف.
    const again = await approveStocktake(res.sessionId, MGR2);
    expect(again.alreadyApproved).toBe(true);
    expect((await openingMovements(res.sessionId)).length).toBe(2);
  });

  it("الاعتماد بلا توقيع أول يُرفض دائماً في الافتتاحية — حتى بصفر فروقات", async () => {
    await enableOpeningMode();
    const res = await mkOpening({ variantIds: [4] });
    const aid = await firstAssignmentId(res.sessionId);
    await insertCount(res.sessionId, 4, aid, 0); // يطابق الدفتر (لا صفّ = 0)
    await forceStocktakeReview(res.sessionId, MGR);
    await approveAllReadyItems(res.sessionId, MGR);
    await expectTrpc(approveStocktake(res.sessionId, MGR2), "PRECONDITION_FAILED", /توقيع أول/);
    // والتوقيع الأول مقبول رغم صفر الفروقات (الاعتماد يختم openedAt — يحتاج أربع عيون).
    await firstSignStocktake(res.sessionId, MGR);
    const ok = await approveStocktake(res.sessionId, MGR2);
    expect(ok.ok).toBe(true);
    expect((await stockRow(4))?.openedAt).not.toBeNull();
  });

  it("صنف بِيع بالسالب بعد عدّه: يُعتمد برصيده السالب الحقيقي ويُفتتَح (لا حجب للجلسة)", async () => {
    await enableOpeningMode();
    const res = await mkOpening({ variantIds: [1] });
    const aid = await firstAssignmentId(res.sessionId);
    const countAt = new Date(Date.now() - 60_000);
    await insertCount(res.sessionId, 1, aid, 5, countAt);

    // بيعٌ لاحق للعدّ تجاوز المعدود (٨ قطع) — محاكاة حركة بيع بالسالب (ش٢ لاحقاً): حركة OUT + رصيد -8.
    await db().insert(s.inventoryMovements).values({
      variantId: 1,
      branchId: 1,
      movementType: "OUT",
      quantity: 8,
      referenceType: "INVOICE",
      referenceId: 999,
      createdAt: new Date(Date.now() - 10_000),
    });
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: -8 });

    await forceStocktakeReview(res.sessionId, MGR);
    await approveAllReadyItems(res.sessionId, MGR);
    await firstSignStocktake(res.sessionId, MGR);
    const ok = await approveStocktake(res.sessionId, MGR2);
    expect(ok.ok).toBe(true);

    // adjusted = 5 (العدّ) − 8 (بيع لاحق) = -3 — الرصيد الحقيقي، مفتوحاً وصارماً من الآن.
    const row = await stockRow(1);
    expect(row?.quantity).toBe(-3);
    expect(row?.openedAt).not.toBeNull();
    expect((await db().select().from(s.accountingEntries)).length).toBe(0);
  });

  it("انقضاء النافذة بين الإنشاء والاعتماد ⇒ الاعتماد يُرفض برسالة تمديد", async () => {
    await enableOpeningMode();
    const res = await mkOpening({ variantIds: [1] });
    const aid = await firstAssignmentId(res.sessionId);
    await insertCount(res.sessionId, 1, aid, 10);
    await forceStocktakeReview(res.sessionId, MGR);
    await approveAllReadyItems(res.sessionId, MGR);
    await firstSignStocktake(res.sessionId, MGR);
    await expireOpeningWindow();
    await expectTrpc(approveStocktake(res.sessionId, MGR2), "PRECONDITION_FAILED", /مدّد النافذة/);
  });
});

describe("فصل المهام في الاعتماد الافتتاحي", () => {
  async function readySession(assignments?: CreateStocktakeInput["assignments"]) {
    const res = await mkOpening({ variantIds: [1], assignments: assignments ?? [{ name: "عامل أ", method: "PIN" }] });
    const aid = await firstAssignmentId(res.sessionId);
    await insertCount(res.sessionId, 1, aid, 15);
    await forceStocktakeReview(res.sessionId, MGR);
    await approveAllReadyItems(res.sessionId, MGR);
    return res;
  }

  it("منشئ الجلسة لا يعتمدها (والموقّع الأول ≠ المعتمد) — وadmin مُستثنى", async () => {
    await enableOpeningMode();
    const a = await readySession();
    await firstSignStocktake(a.sessionId, MGR2);
    await expectTrpc(approveStocktake(a.sessionId, MGR), "FORBIDDEN", /أنشأتَ هذه الجلسة/);
    // الموقّع الأول نفسه لا يعتمد (السلوك القائم محفوظ).
    await expectTrpc(approveStocktake(a.sessionId, MGR2), "FORBIDDEN", /مسؤول آخر/);
    // admin يعبر استثناء المنشئ (جلسة أنشأها admin نفسه).
    const b = await (async () => {
      const r = await mkOpening({ branchId: 2, variantIds: [2] }, ADMIN);
      const aid = await firstAssignmentId(r.sessionId);
      await insertCount(r.sessionId, 2, aid, 3);
      await forceStocktakeReview(r.sessionId, ADMIN);
      await approveAllReadyItems(r.sessionId, MGR);
      await firstSignStocktake(r.sessionId, MGR);
      return r;
    })();
    const ok = await approveStocktake(b.sessionId, ADMIN);
    expect(ok.ok).toBe(true);
  });

  it("من كُلّف بالعدّ (تكليف USER) لا يعتمد", async () => {
    await enableOpeningMode();
    const a = await readySession([{ name: "المدير الثاني يعدّ", method: "USER", userId: MGR2.userId }]);
    await firstSignStocktake(a.sessionId, MGR);
    await expectTrpc(approveStocktake(a.sessionId, MGR2), "FORBIDDEN", /كُلّفتَ بالعدّ/);
  });
});

describe("انحدار: الجرد الدوري لم يتغيّر سلوكه أثناء وضع الافتتاح الفعّال", () => {
  it("جلسة NORMAL: قيدا عجز/زيادة بمفاتيح STOCKTAKE:* يُرحَّلان كما هما وحركاتها بمرجع STOCKTAKE", async () => {
    await enableOpeningMode(); // الوضع فعّال — يجب ألا يسرّب سلوكه للجرد الدوري
    await db().insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: 50 },
      { variantId: 2, branchId: 1, quantity: 100 },
    ]);
    const res = await createStocktakeSession(
      {
        name: "دوري",
        branchId: 1,
        scopeType: "MANUAL",
        variantIds: [1, 2],
        assignments: [{ name: "عامل", method: "PIN" }],
      },
      MGR,
    );
    const aid = await firstAssignmentId(res.sessionId);
    // ضمن الحدَّين معاً (نسبة ≤5% وقيمة ≤25000) ⇒ تسوية تلقائية بلا قرار صريح — سلوك دوري قياسي.
    await insertCount(res.sessionId, 1, aid, 48); // عجز 2/50 = 4% × 250 = 500
    await insertCount(res.sessionId, 2, aid, 101); // زيادة 1/100 = 1% × 1500 = 1500
    await forceStocktakeReview(res.sessionId, MGR);
    await approveAllReadyItems(res.sessionId, MGR);
    const ok = await approveStocktake(res.sessionId, MGR2);
    expect(ok.ok).toBe(true);
    expect(ok.shortExpense).toBe("500.00");
    expect(ok.overGain).toBe("1500.00");

    const entries = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));
    const keys = entries.map((e) => String(e.dedupeKey)).sort();
    expect(keys).toEqual([`STOCKTAKE:${res.sessionId}:OVER`, `STOCKTAKE:${res.sessionId}:SHORT`]);

    const stMoves = await db()
      .select()
      .from(s.inventoryMovements)
      .where(and(eq(s.inventoryMovements.referenceType, "STOCKTAKE"), eq(s.inventoryMovements.referenceId, res.sessionId)));
    expect(stMoves.length).toBe(2);

    // الجرد الدوري لا يفتتح: openedAt يبقى فارغاً (يُعدّ lastCountedAt فقط).
    expect((await stockRow(1))?.openedAt).toBeNull();
    expect((await stockRow(2))?.openedAt).toBeNull();
  });
});
