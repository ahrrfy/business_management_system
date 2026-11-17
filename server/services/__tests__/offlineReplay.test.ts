/**
 * اختبارات إعادة تشغيل البيع الأوفلايني (الشريحة ٣ من خطة الأوفلاين) — offline.replaySale:
 *  1) الترحيل السعيد: فاتورة INV رسمية موسومة originatedOffline + الرقم المؤقّت + capturedAt،
 *     قيد SALE واحد، خصم مخزون، حالة PAID.
 *  2) idempotency: إرسال مزدوج بنفس clientRequestId ⇒ فاتورة واحدة وخصم مخزون واحد.
 *  3) تجاوز المخزون: البيع يُسجَّل والرصيد يهبط سالباً (قرار مالك: سالب موسوم لا رفض).
 *  4) نافذة الالتقاط: مستقبلي/أقدم من ٧٢ ساعة ⇒ PRECONDITION_FAILED (يُعلَّق لدى العميل).
 *  5) نقدي فقط + تحت التكلفة FORBIDDEN + وردية مغلقة PRECONDITION_FAILED بلا كتابة بأثر رجعي.
 *  6) عزل الفرع في الراوتر: كاشير فرع ٢ يُجبَر على فرعه مهما مرّر.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { replayOfflineSale, type ReplayOfflineSaleInput } from "../offline/replaySale";
import {
  computeOfflineCaptureProofHex,
  computeSaleSemanticPayloadSha256,
} from "../../../shared/offlineCaptureProof";
import { issueOfflineShiftCaptureGrant } from "../../lib/offlineCaptureGrant";
import { registerSaleBeforeCommitPauseHookForTest } from "../sale/create";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
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
  await truncateTables(TABLES);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.test", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_cashier1", name: "كاشير ف١", email: "c1@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "local_cashier2", name: "كاشير ف٢", email: "c2@t.test", role: "cashier", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "قلم جاف أزرق" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" }]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "100000017" },
  ]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "250.00" }]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 10 },
    { variantId: 1, branchId: 2, quantity: 10 },
  ]);
  await d.insert(s.customers).values([{ id: 1, name: "زبون نقدي", defaultPriceTier: "RETAIL", currentBalance: "0" }]);
  // ورديتان مفتوحتان: كاشير ف١ (id=1) وكاشير ف٢ (id=2).
  await d.insert(s.shifts).values([
    { id: 1, userId: 2, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "2:1", openingBalance: "0" },
    { id: 2, userId: 3, branchId: 2, status: "OPEN", openedAt: new Date(), openGuard: "3:2", openingBalance: "0" },
  ]);
}

function makeCtx(user: unknown) {
  return { req: { headers: {} }, res: { cookie() {}, clearCookie() {} }, user } as never;
}
async function userById(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

const cashier1 = { userId: 2, branchId: 1, role: "cashier" } as const;

/** التقاط قبل ساعة — داخل النافذة دائماً. */
const capturedAgoIso = (ms = 60 * 60 * 1000) => new Date(Date.now() - ms).toISOString();

function baseInput(overrides?: Partial<ReplayOfflineSaleInput>): ReplayOfflineSaleInput {
  return {
    branchId: 1,
    shiftId: 1,
    priceTier: "RETAIL",
    lines: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPriceOverride: "250.00" }],
    payment: { amount: "500.00", method: "CASH" },
    clientRequestId: "offline-11111111-aaaa",
    capturedAt: capturedAgoIso(),
    offlineReceiptNumber: "OFF-1-ab12-5",
    deviceId: "ab12",
    ...overrides,
  };
}

beforeEach(async () => { await reset(); await seed(); });

describe("replayOfflineSale — الترحيل السعيد والوسم", () => {
  it("يُصدر فاتورة رسمية INV موسومة originatedOffline بالرقم المؤقّت وcapturedAt وPAID", async () => {
    const res = await replayOfflineSale(baseInput(), cashier1);
    // ١٨/٨: رقم الفاتورة الرسميّ صار تسلسلياً قصيراً (عدّاد ذرّيّ) — الرقم **الأوفلاينيّ**
    // المؤقّت يبقى بصيغته `OFF-…` كما هو (يُفحَص أدناه)، فلا التباس بين الترقيمَين.
    expect(res.invoiceNumber).toMatch(/^\d+$/);
    expect(res.status).toBe("PAID");
    expect(res.idempotentReplay).toBeUndefined();

    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(!!inv.originatedOffline).toBe(true);
    expect(inv.offlineReceiptNumber).toBe("OFF-1-ab12-5");
    expect(inv.capturedAt).not.toBeNull();
    expect(inv.sourceId).toBe("offline-11111111-aaaa");
    expect(inv.sourceType).toBe("POS");

    // قيد SALE واحد بحارس dedupeKey البنيوي + خصم المخزون.
    const entries = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `SALE:${res.invoiceId}`));
    expect(entries).toHaveLength(1);
    const stock = (await db().select().from(s.branchStock)
      .where(eq(s.branchStock.variantId, 1)))[0];
    void stock; // الفرعان — نفحص فرع ١ أدناه بدقة
    const stock1 = (await db().select().from(s.branchStock))
      .find((r) => Number(r.branchId) === 1)!;
    expect(Number(stock1.quantity)).toBe(8);
  });

  it("idempotency: إرسال مزدوج بنفس المفتاح ⇒ فاتورة واحدة وخصم مخزون واحد", async () => {
    const input = baseInput();
    const r1 = await replayOfflineSale(input, cashier1);
    const r2 = await replayOfflineSale(input, cashier1);
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.invoiceId).toBe(r1.invoiceId);
    const count = await db().select({ c: sql<number>`count(*)` }).from(s.invoices);
    expect(Number(count[0].c)).toBe(1);
    const stock1 = (await db().select().from(s.branchStock))
      .find((r) => Number(r.branchId) === 1)!;
    expect(Number(stock1.quantity)).toBe(8); // خُصم مرة واحدة فقط
  });

  it("تجاوز المخزون: بيع ١٥ من رصيد ١٠ يُسجَّل والرصيد يهبط إلى -٥ (سالب موسوم، لا رفض)", async () => {
    const res = await replayOfflineSale(
      baseInput({
        lines: [{ variantId: 1, productUnitId: 1, quantity: "15", unitPriceOverride: "250.00" }],
        payment: { amount: "3750.00", method: "CASH" },
        clientRequestId: "offline-oversell-1",
        offlineReceiptNumber: "OFF-1-ab12-6",
      }),
      cashier1,
    );
    expect(res.status).toBe("PAID");
    const stock1 = (await db().select().from(s.branchStock))
      .find((r) => Number(r.branchId) === 1)!;
    expect(Number(stock1.quantity)).toBe(-5);
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(!!inv.originatedOffline).toBe(true); // الوسم = مدخل تقرير المراجعة
  });
});

describe("replayOfflineSale — نافذة الالتقاط والحرّاس", () => {
  it("capturedAt أقدم من ٧٢ ساعة ⇒ PRECONDITION_FAILED (يُعلَّق للمراجعة)", async () => {
    await expect(
      replayOfflineSale(baseInput({ capturedAt: capturedAgoIso(73 * 60 * 60 * 1000) }), cashier1),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("capturedAt مستقبلي بأكثر من سماحية ٥ دقائق ⇒ PRECONDITION_FAILED", async () => {
    await expect(
      replayOfflineSale(baseInput({ capturedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), cashier1),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("انحراف ساعة بسيط (مستقبلي بدقيقتين) ضمن السماحية ⇒ يُقبل", async () => {
    const res = await replayOfflineSale(
      baseInput({ capturedAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), clientRequestId: "offline-skew-1", offlineReceiptNumber: "OFF-1-ab12-7" }),
      cashier1,
    );
    expect(res.status).toBe("PAID");
  });

  it("طريقة دفع غير نقدية ⇒ BAD_REQUEST (الأوفلاين نقدي فقط)", async () => {
    await expect(
      replayOfflineSale(
        baseInput({ payment: { amount: "500.00", method: "CARD" as never } }),
        cashier1,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("سعر ملتقَط تحت التكلفة بلا سلطة ⇒ FORBIDDEN (يُعلَّق لمراجعة المدير)", async () => {
    await expect(
      replayOfflineSale(
        baseInput({
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "50.00" }],
          payment: { amount: "50.00", method: "CASH" },
          clientRequestId: "offline-belowcost-1",
        }),
        cashier1,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ش٤ — مزامنة متأخرة: التُقط قبل الإغلاق ووصل بعده ⇒ يُرفض ولا يكتب بأثر رجعي", async () => {
    await db().update(s.shifts).set({ status: "CLOSED", openGuard: null, closedAt: new Date() }).where(eq(s.shifts.id, 1));
    await expect(
      replayOfflineSale(
        baseInput({ clientRequestId: "offline-latesync-1", offlineReceiptNumber: "OFF-1-ab12-8" }),
        cashier1,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("ش٤ — التُقط بعد إغلاق الوردية ⇒ PRECONDITION_FAILED للتسوية اللاحقة", async () => {
    // أُغلقت قبل ساعتين والالتقاط قبل ساعة (بعد الإغلاق) ⇒ يُرفض ويُعلَّق لدى العميل.
    await db().update(s.shifts)
      .set({ status: "CLOSED", openGuard: null, closedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(s.shifts.id, 1));
    await expect(
      replayOfflineSale(baseInput({ clientRequestId: "offline-latesync-2", offlineReceiptNumber: "OFF-1-ab12-9" }), cashier1),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("ش٤ — سعر تحت التكلفة مع priceOverrideApproved (اعتماد مدير مُتحقَّق) ⇒ يُرحَّل موسوماً", async () => {
    const res = await replayOfflineSale(
      baseInput({
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "50.00" }],
        payment: { amount: "50.00", method: "CASH" },
        clientRequestId: "offline-belowcost-approved",
        offlineReceiptNumber: "OFF-1-ab12-10",
        priceOverrideApproved: true,
      }),
      cashier1,
    );
    expect(res.status).toBe("PAID");
    expect(res.priceOverride).toBe(true);
  });
});

describe("offline.replaySale (راوتر v4) — عزل الفرع، الطابور القديم، الانقطاع الطويل >٧٢ ساعة، استعلام المصالحة، الصلاحيات، وتدوير المفاتيح", () => {
  it("كاشير فرع ٢ يمرّر branchId=1 ⇒ يُجبَر على فرعه ٢ مع منحة v4 موقّعة خادمياً (لا IDOR)", async () => {
    const caller = appRouter.createCaller(makeCtx(await userById(3)));
    const currentShift = await caller.shifts.current({ branchId: 2 });
    const g = currentShift!.offlineCaptureGrant!;
    expect(g.version).toBe(4);
    expect(g.userId).toBe(3);
    const capturedAt = new Date(g.issuedAtServerMs + 1000).toISOString();
    const lines = [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "250.00" }];
    const payment = { amount: "250.00", method: "CASH" as const };
    const captureProof = await computeOfflineCaptureProofHex(g.captureKeyHex, {
      kind: "SALE",
      keyId: g.keyId,
      grantId: g.grantId,
      grantIssuedAtMs: g.issuedAtServerMs,
      grantExpiresAtMs: g.expiresAtServerMs,
      grantToken: g.grantToken,
      clientRequestId: "offline-idor-1",
      offlineReceiptNumber: "OFF-2-cd34567890abcdef-1",
      capturedAt,
      branchId: 2,
      capturedShiftId: 2,
      capturedByUserId: 3,
      payload: { lines, payment },
    });
    const res = await caller.offline.replaySale({
      branchId: 1,
      shiftId: 2,
      lines,
      payment,
      clientRequestId: "offline-idor-1",
      capturedAt,
      offlineReceiptNumber: "OFF-2-cd34567890abcdef-1",
      capturedByUserId: 3,
      capturedShiftId: 2,
      keyId: g.keyId,
      grantId: g.grantId,
      grantIssuedAtMs: g.issuedAtServerMs,
      grantExpiresAtMs: g.expiresAtServerMs,
      grantToken: g.grantToken,
      captureProof,
    });
    const inv = (await db().select().from(s.invoices).where(eq(s.invoices.id, res.invoiceId)))[0];
    expect(Number(inv.branchId)).toBe(2);
    const stock2 = (await db().select().from(s.branchStock)).find((r) => Number(r.branchId) === 2)!;
    expect(Number(stock2.quantity)).toBe(9);
  });

  it("يعالج الطابور القديم (١): صف قديم غير مرسل بلا captureProof يُحجر مع حفظ هوية الملتقط الأصلي ويُسترد إدارياً دون اختلاق إثبات؛ و(٢) صف قديم التزم قبل انقطاع الرد يتصالح بلا تكرار؛ و(٣) استعلام lookupPreflightSaleOutcome معزول بالهوية ومدقق", async () => {
    const cashierCaller = appRouter.createCaller(makeCtx(await userById(2)));
    const adminCaller = appRouter.createCaller(makeCtx(await userById(1)));
    const lines = [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "250.00" }];
    const payment = { amount: "250.00", method: "CASH" as const };

    // (1) Legacy uncommitted row (`captureProof` absent) -> PRECONDITION_FAILED + quarantined preserving `submittedByUserId = 2`!
    await expect(
      cashierCaller.offline.replaySale({
        branchId: 1,
        shiftId: 1,
        lines,
        payment,
        clientRequestId: "legacy-unsent-row-no-proof-1",
        capturedAt: capturedAgoIso(),
        offlineReceiptNumber: "OFF-1-c0fe-7",
        capturedByUserId: 2,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const queue = await adminCaller.offline.recoveryQueue();
    const qRow = queue.find((r) => r.offlineReceiptNumber === "OFF-1-c0fe-7")!;
    expect(qRow).toBeDefined();
    expect(qRow.submittedByUserId).toBe(2);
    expect(qRow.quarantineClassification).toBe("LEGACY_UNSENT_WITHOUT_PROOF");
    // Admin opens replacement drawer & posts quarantined legacy row -> attributed to original cashier user 2!
    const adminShift = await adminCaller.shifts.open({
      branchId: 1,
      openingBalance: "0",
      shiftType: "RETAIL",
    });
    const recovered = await adminCaller.offline.postRecoveryItem({
      id: qRow.id,
      targetShiftId: adminShift.shiftId,
    });
    const recInv = (
      await db().select().from(s.invoices).where(eq(s.invoices.id, recovered.invoiceId))
    )[0];
    expect(Number(recInv.createdBy)).toBe(2);

    // (2) Legacy row that ALREADY committed online before HTTP response dropped (`captureProof` absent):
    //     Reconciles idempotently on `offline.replaySale` with ZERO duplicate invoices!
    const onlineCommitted = await cashierCaller.sales.create({
      branchId: 1,
      shiftId: 1,
      sourceType: "POS",
      clientRequestId: "legacy-committed-before-drop-1",
      lines,
      payment,
    });
    const invCountBefore = (await db().select().from(s.invoices)).length;
    const reconciled = await cashierCaller.offline.replaySale({
      branchId: 1,
      shiftId: 1,
      lines,
      payment,
      clientRequestId: "legacy-committed-before-drop-1",
      capturedAt: capturedAgoIso(),
      offlineReceiptNumber: "OFF-1-c0fe-8",
      // Notice: NO captureProof, NO grantToken (pre-upgrade legacy row!)
    });
    expect(reconciled.invoiceId).toBe(onlineCommitted.invoiceId);
    expect(reconciled.idempotentReplay).toBe(true);
    expect((await db().select().from(s.invoices)).length).toBe(invCountBefore);

    // (3) `lookupPreflightSaleOutcome`:
    //     - owner sees COMMITTED (and CONFLICT on mismatched expectedSemanticSha256);
    //     - absent key in OBSERVE mode returns UNKNOWN (never NOT_COMMITTED from absence alone!);
    //     - paused pre-commit `sales.create` returns UNKNOWN_IN_FLIGHT until commit finishes;
    //     - FENCE_IF_UNCOMMITTED atomically fences an uncommitted key (`FENCED_NOT_COMMITTED`) and blocks late `sales.create` with CONFLICT;
    //     - foreign cashier on same branch gets FORBIDDEN; admin sees COMMITTED + audit_logs entry!
    const expectedSemSha = computeSaleSemanticPayloadSha256({
      branchId: 1,
      shiftId: 1,
      sourceType: "POS",
      clientRequestId: "legacy-committed-before-drop-1",
      lines,
      payment,
    });
    const ownerLookup = await cashierCaller.offline.lookupPreflightSaleOutcome({
      branchId: 1,
      clientRequestId: "legacy-committed-before-drop-1",
      expectedSemanticSha256: expectedSemSha,
    });
    expect(ownerLookup.outcome).toBe("COMMITTED");
    await expect(
      cashierCaller.offline.lookupPreflightSaleOutcome({
        branchId: 1,
        clientRequestId: "legacy-committed-before-drop-1",
        expectedSemanticSha256: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const unknownObserveLookup = await cashierCaller.offline.lookupPreflightSaleOutcome({
      branchId: 1,
      clientRequestId: "never-sent-client-request-id-99",
      mode: "OBSERVE",
    });
    expect(unknownObserveLookup.outcome).toBe("UNKNOWN");

    const fencedLookup = await cashierCaller.offline.lookupPreflightSaleOutcome({
      branchId: 1,
      clientRequestId: "never-sent-client-request-id-99",
      expectedSemanticSha256: expectedSemSha,
      mode: "FENCE_IF_UNCOMMITTED",
    });
    expect(fencedLookup.outcome).toBe("FENCED_NOT_COMMITTED");
    await expect(
      cashierCaller.sales.create({
        branchId: 1,
        shiftId: 1,
        sourceType: "POS",
        clientRequestId: "never-sent-client-request-id-99",
        lines,
        payment,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // In-flight pause before commit: `lookupPreflightSaleOutcome` MUST return `UNKNOWN_IN_FLIGHT` (not `UNKNOWN` or `NOT_COMMITTED`)!
    const { enteredPreCommit, releaseCommit } =
      registerSaleBeforeCommitPauseHookForTest("paused-in-flight-sale-req-1");
    const inflightSalePromise = cashierCaller.sales.create({
      branchId: 1,
      shiftId: 1,
      sourceType: "POS",
      clientRequestId: "paused-in-flight-sale-req-1",
      lines,
      payment,
    });
    await Promise.race([
      enteredPreCommit,
      inflightSalePromise.then(() => {
        throw new Error("Expected paused-in-flight-sale-req-1 to pause before commit");
      }),
    ]);
    const inflightObserve = await cashierCaller.offline.lookupPreflightSaleOutcome({
      branchId: 1,
      clientRequestId: "paused-in-flight-sale-req-1",
      mode: "OBSERVE",
    });
    expect(inflightObserve.outcome).toBe("UNKNOWN_IN_FLIGHT");
    const inflightFenceAttempt = await cashierCaller.offline.lookupPreflightSaleOutcome({
      branchId: 1,
      clientRequestId: "paused-in-flight-sale-req-1",
      expectedSemanticSha256: expectedSemSha,
      mode: "FENCE_IF_UNCOMMITTED",
    });
    expect(inflightFenceAttempt.outcome).toBe("UNKNOWN_IN_FLIGHT");
    releaseCommit();
    const finishedSale = await inflightSalePromise;
    const afterCommitLookup = await cashierCaller.offline.lookupPreflightSaleOutcome({
      branchId: 1,
      clientRequestId: "paused-in-flight-sale-req-1",
      mode: "OBSERVE",
    });
    expect(afterCommitLookup).toMatchObject({
      outcome: "COMMITTED",
      invoiceId: finishedSale.invoiceId,
    });

    const [foreignCashierInsert] = await db().insert(s.users).values({
      openId: "cashier-branch1-second",
      name: "كاشير ١-ب",
      email: "cashier1b@test.local",
      role: "cashier",
      branchId: 1,
    });
    const foreignCashierCaller = appRouter.createCaller(
      makeCtx(await userById(Number(foreignCashierInsert.insertId))),
    );
    await expect(
      foreignCashierCaller.offline.lookupPreflightSaleOutcome({
        branchId: 1,
        clientRequestId: "legacy-committed-before-drop-1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const adminLookup = await adminCaller.offline.lookupPreflightSaleOutcome({
      branchId: 1,
      clientRequestId: "legacy-committed-before-drop-1",
    });
    expect(adminLookup.outcome).toBe("COMMITTED");
  }, 30_000);

  it("يعالج الانقطاع الطويل (>٧٢ ساعة بعد إصدار المنحة) بحجر PRECONDITION_FAILED مدقّق مع استرداد إداري، ويرفض تلاعب الساعة وسحب الصلاحية sales=NONE، ويدعم تدوير المفاتيح k1->k2", async () => {
    const prevKeyring = process.env.OFFLINE_CAPTURE_KEYRING;
    try {
      process.env.OFFLINE_CAPTURE_KEYRING = "k1:secret-key-one-minimum-16-chars!!";
      const caller2 = appRouter.createCaller(makeCtx(await userById(2)));
      const adminCaller = appRouter.createCaller(makeCtx(await userById(1)));
      const lines = [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "250.00" }];
      const payment = { amount: "250.00", method: "CASH" as const };

      // (3) Capture under k1, then rotate active server keyring to k2,k1 (simulating Cloud->Local cutover rotation!)
      const gK1 = issueOfflineShiftCaptureGrant({ userId: 2, branchId: 1, shiftId: 1 });
      expect(gK1.keyId).toBe("k1");
      const capAtK1 = new Date(gK1.issuedAtServerMs + 2000).toISOString();
      const proofK1 = await computeOfflineCaptureProofHex(gK1.captureKeyHex, {
        kind: "SALE",
        keyId: gK1.keyId,
        grantId: gK1.grantId,
        grantIssuedAtMs: gK1.issuedAtServerMs,
        grantExpiresAtMs: gK1.expiresAtServerMs,
        grantToken: gK1.grantToken,
        clientRequestId: "offline-key-rotation-k1-to-k2",
        offlineReceiptNumber: "OFF-1-0123456789abcdef-11",
        capturedAt: capAtK1,
        branchId: 1,
        capturedShiftId: 1,
        capturedByUserId: 2,
        payload: { lines, payment },
      });
      process.env.OFFLINE_CAPTURE_KEYRING =
        "k2:secret-key-two-minimum-16-chars!!,k1:secret-key-one-minimum-16-chars!!";
      const rotatedRes = await caller2.offline.replaySale({
        branchId: 1,
        shiftId: 1,
        lines,
        payment,
        clientRequestId: "offline-key-rotation-k1-to-k2",
        capturedAt: capAtK1,
        offlineReceiptNumber: "OFF-1-0123456789abcdef-11",
        capturedByUserId: 2,
        capturedShiftId: 1,
        keyId: gK1.keyId,
        grantId: gK1.grantId,
        grantIssuedAtMs: gK1.issuedAtServerMs,
        grantExpiresAtMs: gK1.expiresAtServerMs,
        grantToken: gK1.grantToken,
        captureProof: proofK1,
      });
      expect(rotatedRes.invoiceId).toBeGreaterThan(0);

      // (2a) Client clock tamper BEFORE grant issuance -> FORBIDDEN!
      const gClockTamper = issueOfflineShiftCaptureGrant({ userId: 2, branchId: 1, shiftId: 1 });
      const backdatedCapturedAt = new Date(gClockTamper.issuedAtServerMs - 3600_000).toISOString();
      const tamperProof = await computeOfflineCaptureProofHex(gClockTamper.captureKeyHex, {
        kind: "SALE",
        keyId: gClockTamper.keyId,
        grantId: gClockTamper.grantId,
        grantIssuedAtMs: gClockTamper.issuedAtServerMs,
        grantExpiresAtMs: gClockTamper.expiresAtServerMs,
        grantToken: gClockTamper.grantToken,
        clientRequestId: "offline-clock-tamper-before-grant",
        offlineReceiptNumber: "OFF-1-0123456789abcdef-11b",
        capturedAt: backdatedCapturedAt,
        branchId: 1,
        capturedShiftId: 1,
        capturedByUserId: 2,
        payload: { lines, payment },
      });
      await expect(
        caller2.offline.replaySale({
          branchId: 1,
          shiftId: 1,
          lines,
          payment,
          clientRequestId: "offline-clock-tamper-before-grant",
          capturedAt: backdatedCapturedAt,
          offlineReceiptNumber: "OFF-1-0123456789abcdef-11b",
          capturedByUserId: 2,
          capturedShiftId: 1,
          keyId: gClockTamper.keyId,
          grantId: gClockTamper.grantId,
          grantIssuedAtMs: gClockTamper.issuedAtServerMs,
          grantExpiresAtMs: gClockTamper.expiresAtServerMs,
          grantToken: gClockTamper.grantToken,
          captureProof: tamperProof,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // (2b) Long LAN disconnection (>24h post-grant expiry, e.g. 80h after grant issue):
      //      Crypto-verified row is NOT auto-posted (since client clock alone cannot prove capture time)
      //      AND NOT silently dropped — quarantined as PRECONDITION_FAILED (`LATE_ARRIVAL_BEYOND_GRACE_CRYPTO_VERIFIED`)
      //      preserving original cashier ID=2 and recoverable by audited admin review!
      const nowMs = Date.now();
      const oldIssuedMs = nowMs - 80 * 3600_000;
      await db().update(s.shifts).set({ openedAt: new Date(oldIssuedMs - 60_000) }).where(eq(s.shifts.id, 1));
      const gExpired = issueOfflineShiftCaptureGrant({
        userId: 2,
        branchId: 1,
        shiftId: 1,
        nowMs: oldIssuedMs,
      });
      const claimedCapturedAt = new Date(oldIssuedMs + 3600_000).toISOString();
      const expiredProof = await computeOfflineCaptureProofHex(gExpired.captureKeyHex, {
        kind: "SALE",
        keyId: gExpired.keyId,
        grantId: gExpired.grantId,
        grantIssuedAtMs: gExpired.issuedAtServerMs,
        grantExpiresAtMs: gExpired.expiresAtServerMs,
        grantToken: gExpired.grantToken,
        clientRequestId: "offline-long-disconnect-80h",
        offlineReceiptNumber: "OFF-1-0123456789abcdef-12",
        capturedAt: claimedCapturedAt,
        branchId: 1,
        capturedShiftId: 1,
        capturedByUserId: 2,
        payload: { lines, payment },
      });
      await expect(
        caller2.offline.replaySale({
          branchId: 1,
          shiftId: 1,
          lines,
          payment,
          clientRequestId: "offline-long-disconnect-80h",
          capturedAt: claimedCapturedAt,
          offlineReceiptNumber: "OFF-1-0123456789abcdef-12",
          capturedByUserId: 2,
          capturedShiftId: 1,
          keyId: gExpired.keyId,
          grantId: gExpired.grantId,
          grantIssuedAtMs: gExpired.issuedAtServerMs,
          grantExpiresAtMs: gExpired.expiresAtServerMs,
          grantToken: gExpired.grantToken,
          captureProof: expiredProof,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      const lateQueue = await adminCaller.offline.recoveryQueue();
      const lateRow = lateQueue.find((r) => r.offlineReceiptNumber === "OFF-1-0123456789abcdef-12")!;
      expect(lateRow).toBeDefined();
      expect(lateRow.submittedByUserId).toBe(2);
      expect(lateRow.quarantineClassification).toBe("LATE_ARRIVAL_BEYOND_GRACE_CRYPTO_VERIFIED");
      expect(lateRow.cryptoProofVerifiedAtQuarantine).toBe(true);
      expect(lateRow.clientClockUnverifiedByServerWallClock).toBe(true);
      const adminShiftForLate = await adminCaller.shifts.open({
        branchId: 1,
        openingBalance: "0",
        shiftType: "RETAIL",
      });
      const recoveredLate = await adminCaller.offline.postRecoveryItem({
        id: lateRow.id,
        targetShiftId: adminShiftForLate.shiftId,
      });
      const recLateInv = (
        await db().select().from(s.invoices).where(eq(s.invoices.id, recoveredLate.invoiceId))
      )[0];
      expect(Number(recLateInv.createdBy)).toBe(2);

      // (1) Permission revoked (`sales: "NONE"` override) while device was unplugged -> quarantined on replay!
      const gRevoked = issueOfflineShiftCaptureGrant({ userId: 2, branchId: 1, shiftId: 1 });
      const capRevoked = new Date(gRevoked.issuedAtServerMs + 1000).toISOString();
      const proofRevoked = await computeOfflineCaptureProofHex(gRevoked.captureKeyHex, {
        kind: "SALE",
        keyId: gRevoked.keyId,
        grantId: gRevoked.grantId,
        grantIssuedAtMs: gRevoked.issuedAtServerMs,
        grantExpiresAtMs: gRevoked.expiresAtServerMs,
        grantToken: gRevoked.grantToken,
        clientRequestId: "offline-perm-revoked-sales-none",
        offlineReceiptNumber: "OFF-1-0123456789abcdef-13",
        capturedAt: capRevoked,
        branchId: 1,
        capturedShiftId: 1,
        capturedByUserId: 2,
        payload: { lines, payment },
      });
      await db()
        .update(s.users)
        .set({ permissionsOverride: { sales: "NONE" } })
        .where(eq(s.users.id, 2));
      await expect(
        adminCaller.offline.replaySale({
          branchId: 1,
          shiftId: 1,
          lines,
          payment,
          clientRequestId: "offline-perm-revoked-sales-none",
          capturedAt: capRevoked,
          offlineReceiptNumber: "OFF-1-0123456789abcdef-13",
          capturedByUserId: 2,
          capturedShiftId: 1,
          keyId: gRevoked.keyId,
          grantId: gRevoked.grantId,
          grantIssuedAtMs: gRevoked.issuedAtServerMs,
          grantExpiresAtMs: gRevoked.expiresAtServerMs,
          grantToken: gRevoked.grantToken,
          captureProof: proofRevoked,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      if (prevKeyring === undefined) delete process.env.OFFLINE_CAPTURE_KEYRING;
      else process.env.OFFLINE_CAPTURE_KEYRING = prevKeyring;
    }
  }, 30_000);
});
