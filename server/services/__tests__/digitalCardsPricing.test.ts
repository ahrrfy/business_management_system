import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import {
  offeringService,
  pricingService,
  providerService,
} from "../digitalCards";

/**
 * البطاقات الرقمية — ش٤: أسعار بداية اليوم (مسودّة/نسخ/نشر/مؤشّر/بلاغ تغيّر).
 * راجع docs/digital-cards-platform-subscriptions-implementation-plan-2026-07-29.md §٧ + §١٧.
 */

const actor = { userId: 1, branchId: 1 };
const actor2 = { userId: 2, branchId: 1 };
const DATE = "2026-07-29";
const NEXT = "2026-07-30";

const TABLES = [
  "digitalPriceChangeReports",
  "digitalCurrentPrices",
  "digitalPriceVersions",
  "digitalPriceBatches",
  "digitalOfferingBranches",
  "digitalOfferings",
  "digitalWallets",
  "digitalProviders",
  "productPrices",
  "productUnitBarcodes",
  "productUnits",
  "productVariants",
  "products",
  "auditLogs",
  "suppliers",
  "categories",
  "users",
  "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seedBase() {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "local_test",
        name: "admin",
        role: "admin",
        loginMethod: "local",
      },
      {
        id: 2,
        openId: "local_mgr",
        name: "مدير آخر",
        role: "manager",
        loginMethod: "local",
      },
    ]);
}

async function mkProvider(name = "آسياسيل") {
  const { supplierId } = await createSupplier({ name }, actor);
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId,
        providerType: "TELECOM",
        settlementMode: "POSTPAID",
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
      },
      actor,
    ),
  );
  return providerId;
}

async function mkOffering(
  providerId: number,
  over: {
    name?: string;
    fixedMargin?: string;
    minimumMargin?: string;
    roundingStep?: string;
    branchIds?: number[];
  } = {},
) {
  const r = await withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: "TELECOM_CARD",
        name: over.name ?? "كارت ١٠ آلاف",
        pricingMode: "FIXED_MARGIN",
        fixedMargin: over.fixedMargin ?? "500",
        minimumMargin: over.minimumMargin ?? "0",
        roundingStep: over.roundingStep ?? "250",
        branches: (over.branchIds ?? [1]).map((branchId) => ({ branchId })),
      },
      actor,
    ),
  );
  return r.offeringId;
}

async function batchRow(id: number) {
  const [b] = await db()
    .select()
    .from(s.digitalPriceBatches)
    .where(eq(s.digitalPriceBatches.id, id));
  return b;
}

async function currentPrice(branchId: number, offeringId: number) {
  const [row] = await db()
    .select({
      priceVersionId: s.digitalCurrentPrices.priceVersionId,
      providerShare: s.digitalPriceVersions.providerShare,
      sellPrice: s.digitalPriceVersions.sellPrice,
      marginAmount: s.digitalPriceVersions.marginAmount,
      validUntil: s.digitalPriceVersions.validUntil,
    })
    .from(s.digitalCurrentPrices)
    .innerJoin(
      s.digitalPriceVersions,
      eq(s.digitalCurrentPrices.priceVersionId, s.digitalPriceVersions.id),
    )
    .where(
      and(
        eq(s.digitalCurrentPrices.branchId, branchId),
        eq(s.digitalCurrentPrices.offeringId, offeringId),
      ),
    );
  return row ?? null;
}

/** يُنشئ مسودّة، يحفظ الحصص، وينشر — الطريق السعيد المختصر. */
async function publishPrices(
  branchId: number,
  providerId: number,
  businessDate: string,
  lines: { offeringId: number; providerShare: string; sellPrice?: string }[],
  who = actor,
) {
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      { branchId, providerId, businessDate },
      who,
    ),
  );
  await withTx((tx) => pricingService.saveDraft(tx, { batchId, lines }, who));
  const res = await withTx((tx) =>
    pricingService.publish(tx, { batchId }, who),
  );
  return { batchId, ...res };
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seedBase();
});

describe("ش٤ — المسودّة", () => {
  it("مسودّة واحدة فقط لكل (فرع×مزوّد×تاريخ) — الاستدعاء الثاني يعيد الأولى", async () => {
    const providerId = await mkProvider();
    const scope = { branchId: 1, providerId, businessDate: DATE };
    const a = await withTx((tx) =>
      pricingService.createOrGetDraft(tx, scope, actor),
    );
    const b = await withTx((tx) =>
      pricingService.createOrGetDraft(tx, scope, actor),
    );
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.batchId).toBe(a.batchId);
  });

  it("سباق createOrGetDraft يعيد الدفعة الفائزة للطلبين", async () => {
    const providerId = await mkProvider();
    const scope = { branchId: 1, providerId, businessDate: DATE };
    const [a, b] = await Promise.all([
      withTx((tx) => pricingService.createOrGetDraft(tx, scope, actor)),
      withTx((tx) => pricingService.createOrGetDraft(tx, scope, actor2)),
    ]);
    expect(a.batchId).toBe(b.batchId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it("قيد القاعدة يمنع مسودّتين متوازيتين حتى بتجاوز الفحص التطبيقيّ", async () => {
    const providerId = await mkProvider();
    await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: DATE },
        actor,
      ),
    );
    // إدراج مباشر يتخطّى الخدمة ⇒ يجب أن ترفضه القاعدة نفسها.
    await expect(
      db().insert(s.digitalPriceBatches).values({
        branchId: 1,
        providerId,
        businessDate: DATE,
        status: "DRAFT",
        createdBy: 1,
      }),
    ).rejects.toThrow();
  });

  it("يحفظ تكلفة الشراء وسعر البيع المدخلين ويحسب الربح منهما", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId, {
      fixedMargin: "500",
      roundingStep: "250",
    });
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: DATE },
        actor,
      ),
    );
    await withTx((tx) =>
      pricingService.saveDraft(
        tx,
        {
          batchId,
          lines: [{ offeringId, providerShare: "9600", sellPrice: "10150" }],
        },
        actor,
      ),
    );

    const [v] = await db()
      .select()
      .from(s.digitalPriceVersions)
      .where(eq(s.digitalPriceVersions.batchId, batchId));
    // التسعير اليومي المباشر لا يقرّب السعر ولا يشتقه من قاعدة ربح قديمة.
    expect(v.providerShare).toBe("9600.00");
    expect(v.sellPrice).toBe("10150.00");
    expect(v.marginAmount).toBe("550.00");
  });

  it("إعادة الحفظ لنفس البطاقة تُحدِّث السطر ولا تُكرّره", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: DATE },
        actor,
      ),
    );
    await withTx((tx) =>
      pricingService.saveDraft(
        tx,
        { batchId, lines: [{ offeringId, providerShare: "9000" }] },
        actor,
      ),
    );
    await withTx((tx) =>
      pricingService.saveDraft(
        tx,
        { batchId, lines: [{ offeringId, providerShare: "9500" }] },
        actor,
      ),
    );

    const rows = await db()
      .select()
      .from(s.digitalPriceVersions)
      .where(eq(s.digitalPriceVersions.batchId, batchId));
    expect(rows).toHaveLength(1);
    expect(rows[0].providerShare).toBe("9500.00");
  });

  it("يرفض تكرار البطاقة في payload بدلاً من نجاح بعدد صفوف مضلل", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: DATE }, actor),
    );

    await expect(
      withTx((tx) => pricingService.saveDraft(tx, {
        batchId,
        lines: [
          { offeringId, providerShare: "9000" },
          { offeringId, providerShare: "9500" },
        ],
      }, actor)),
    ).rejects.toThrow(/مكررة/);
  });

  it("يرفض سطراً لبطاقة خارج مزوّد الدُفعة/فرعها", async () => {
    const p1 = await mkProvider("آسياسيل");
    const p2 = await mkProvider("زين");
    const foreign = await mkOffering(p2);
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId: p1, businessDate: DATE },
        actor,
      ),
    );
    await expect(
      withTx((tx) =>
        pricingService.saveDraft(
          tx,
          { batchId, lines: [{ offeringId: foreign, providerShare: "100" }] },
          actor,
        ),
      ),
    ).rejects.toThrow(/ليس ضمن بطاقات هذا المزوّد/);
  });

  it("يرفض حصة سالبة", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: DATE },
        actor,
      ),
    );
    await expect(
      withTx((tx) =>
        pricingService.saveDraft(
          tx,
          { batchId, lines: [{ offeringId, providerShare: "-1" }] },
          actor,
        ),
      ),
    ).rejects.toThrow(/سالبة/);
  });
});

describe("ش٤ — النشر", () => {
  it("معيار خروج ش٤: النشر يجعل السعر نافذاً فوراً في المؤشّر", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    expect(await currentPrice(1, offeringId)).toBeNull();

    const { batchId, publishedCount } = await publishPrices(
      1,
      providerId,
      DATE,
      [{ offeringId, providerShare: "9500" }],
    );
    expect(publishedCount).toBe(1);
    expect((await batchRow(batchId)).status).toBe("PUBLISHED");

    const live = await currentPrice(1, offeringId);
    expect(live?.sellPrice).toBe("10000.00");
    expect(live?.providerShare).toBe("9500.00");
  });

  it("يرفض النشر إن نقص سعر بطاقة فعّالة واحدة", async () => {
    const providerId = await mkProvider();
    const a = await mkOffering(providerId, { name: "كارت أ" });
    await mkOffering(providerId, { name: "كارت ب" });
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: DATE },
        actor,
      ),
    );
    await withTx((tx) =>
      pricingService.saveDraft(
        tx,
        { batchId, lines: [{ offeringId: a, providerShare: "9500" }] },
        actor,
      ),
    );

    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId }, actor)),
    ).rejects.toThrow(/أسعار ناقصة/);
    expect((await batchRow(batchId)).status).toBe("DRAFT");
  });

  it("عقد النشر exact: لا يستكمل payload الناقص من صفوف مسودة قديمة مخفية", async () => {
    const providerId = await mkProvider();
    const a = await mkOffering(providerId, { name: "كارت أ" });
    const b = await mkOffering(providerId, { name: "كارت ب" });
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: DATE }, actor),
    );
    await withTx((tx) =>
      pricingService.saveDraft(tx, {
        batchId,
        lines: [
          { offeringId: a, providerShare: "9500" },
          { offeringId: b, providerShare: "9500" },
        ],
      }, actor),
    );

    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId, expectedOfferingIds: [a] }, actor)),
    ).rejects.toThrow(/كل بطاقات النطاق/);
    expect((await batchRow(batchId)).status).toBe("DRAFT");
  });

  it("يرفض نشر تاريخ أقدم فوق الدفعة النافذة الأحدث", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, NEXT, [{ offeringId, providerShare: "9500" }]);
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: DATE }, actor),
    );
    await withTx((tx) =>
      pricingService.saveDraft(tx, { batchId, lines: [{ offeringId, providerShare: "9600" }] }, actor),
    );

    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId }, actor)),
    ).rejects.toThrow(/أسعار أحدث/);
  });

  it("يرفض النشر إن نزل الهامش عن الحدّ الأدنى، ولا يترك أثراً جزئياً", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId, {
      fixedMargin: "100",
      minimumMargin: "500",
      roundingStep: "0",
    });
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: DATE },
        actor,
      ),
    );
    await withTx((tx) =>
      pricingService.saveDraft(
        tx,
        { batchId, lines: [{ offeringId, providerShare: "9000" }] },
        actor,
      ),
    );

    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId }, actor)),
    ).rejects.toThrow(/أقلّ من الحدّ الأدنى/);
    expect((await batchRow(batchId)).status).toBe("DRAFT");
    expect(await currentPrice(1, offeringId)).toBeNull();
  });

  it("فشل كتابة سجل التدقيق يُرجع النشر كله ولا يترك سعراً نافذاً", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(tx, { branchId: 1, providerId, businessDate: DATE }, actor),
    );
    await withTx((tx) =>
      pricingService.saveDraft(tx, { batchId, lines: [{ offeringId, providerShare: "9500" }] }, actor),
    );

    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId }, { ...actor, branchId: 1e30 })),
    ).rejects.toThrow();
    expect((await batchRow(batchId)).status).toBe("DRAFT");
    expect(await currentPrice(1, offeringId)).toBeNull();
  });

  it("النشر مرّتين للدُفعة نفسها مرفوض (لا نشر مزدوج)", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    const { batchId } = await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);
    await expect(
      withTx((tx) => pricingService.publish(tx, { batchId }, actor)),
    ).rejects.toThrow(/ليست مسودّة/);
  });

  it("نشر دُفعة جديدة يُسوّد السابقة ويغلق سريان نسخها ويحوّل المؤشّر", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    const first = await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);
    const firstVersionId = (await currentPrice(1, offeringId))!.priceVersionId;

    const second = await publishPrices(1, providerId, NEXT, [
      { offeringId, providerShare: "9750" },
    ]);
    expect(second.supersededBatchId).toBe(first.batchId);
    expect((await batchRow(first.batchId)).status).toBe("SUPERSEDED");

    const [oldVersion] = await db()
      .select()
      .from(s.digitalPriceVersions)
      .where(eq(s.digitalPriceVersions.id, Number(firstVersionId)));
    expect(oldVersion.validUntil).not.toBeNull();
    // النسخة القديمة تبقى محفوظةً كما هي (تاريخيّة غير قابلة للتعديل).
    expect(oldVersion.sellPrice).toBe("10000.00");

    const live = await currentPrice(1, offeringId);
    expect(Number(live!.priceVersionId)).not.toBe(Number(firstVersionId));
    // 9750 + 500 = 10250، وهو أصلاً مضاعفٌ لـ٢٥٠ ⇒ لا يرفعه التقريب.
    expect(live!.sellPrice).toBe("10250.00");
    expect(live!.providerShare).toBe("9750.00");
  });

  it("قيد القاعدة يمنع وجود دُفعتين منشورتين لنفس (الفرع×المزوّد)", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);
    await expect(
      db().insert(s.digitalPriceBatches).values({
        branchId: 1,
        providerId,
        businessDate: NEXT,
        status: "PUBLISHED",
        createdBy: 1,
      }),
    ).rejects.toThrow();
  });

  it("الفروع مستقلّة: نشر في فرع لا يمسّ سعر الفرع الآخر", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId, { branchIds: [1, 2] });
    await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);
    await publishPrices(2, providerId, DATE, [
      { offeringId, providerShare: "9750" },
    ]);

    expect((await currentPrice(1, offeringId))!.providerShare).toBe("9500.00");
    expect((await currentPrice(2, offeringId))!.providerShare).toBe("9750.00");
  });

  it("بطاقة عُطِّلت بعد إدخال سعرها تُسقَط من النشر بدل تثبيت سعرٍ لها", async () => {
    const providerId = await mkProvider();
    const a = await mkOffering(providerId, { name: "كارت أ" });
    const b = await mkOffering(providerId, { name: "كارت ب" });
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: DATE },
        actor,
      ),
    );
    await withTx((tx) =>
      pricingService.saveDraft(
        tx,
        {
          batchId,
          lines: [
            { offeringId: a, providerShare: "9500" },
            { offeringId: b, providerShare: "9500" },
          ],
        },
        actor,
      ),
    );
    await withTx((tx) =>
      offeringService.updateOffering(tx, { id: b, isActive: false }, actor),
    );

    const res = await withTx((tx) =>
      pricingService.publish(tx, { batchId }, actor),
    );
    expect(res.publishedCount).toBe(1);
    expect(await currentPrice(1, b)).toBeNull();
    expect((await currentPrice(1, a))!.sellPrice).toBe("10000.00");
  });

  it("إلغاء المسودّة يمسح سطورها ولا يمسّ السعر النافذ", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);

    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: NEXT },
        actor,
      ),
    );
    await withTx((tx) =>
      pricingService.saveDraft(
        tx,
        { batchId, lines: [{ offeringId, providerShare: "8000" }] },
        actor,
      ),
    );
    await withTx((tx) => pricingService.cancelDraft(tx, { batchId }, actor));

    expect((await batchRow(batchId)).status).toBe("CANCELLED");
    expect(
      await db()
        .select()
        .from(s.digitalPriceVersions)
        .where(eq(s.digitalPriceVersions.batchId, batchId)),
    ).toHaveLength(0);
    expect((await currentPrice(1, offeringId))!.providerShare).toBe("9500.00");
  });
});

describe("ش٤ — النسخ وكشف الصباح", () => {
  it("«نسخ آخر أسعار منشورة» يملأ المسودّة من المؤشّر النافذ", async () => {
    const providerId = await mkProvider();
    const a = await mkOffering(providerId, { name: "كارت أ" });
    const b = await mkOffering(providerId, { name: "كارت ب" });
    await publishPrices(1, providerId, DATE, [
      { offeringId: a, providerShare: "9500" },
      { offeringId: b, providerShare: "4500" },
    ]);

    const res = await withTx((tx) =>
      pricingService.copyPrevious(
        tx,
        { branchId: 1, providerId, businessDate: NEXT },
        actor,
      ),
    );
    expect(res.copiedCount).toBe(2);
    expect(res.skippedCount).toBe(0);

    const sheet = await pricingService.getMorningSheet(db(), {
      branchId: 1,
      providerId,
      businessDate: NEXT,
    });
    expect(sheet.missingCount).toBe(0);
    expect(sheet.rows.find((r) => r.offeringId === a)?.draftProviderShare).toBe(
      "9500.00",
    );
    expect(sheet.rows.find((r) => r.offeringId === b)?.draftProviderShare).toBe(
      "4500.00",
    );
  });

  it("بطاقة جديدة بلا سعر سابق تظهر NEEDS_INPUT وتُحصى في النواقص", async () => {
    const providerId = await mkProvider();
    const a = await mkOffering(providerId, { name: "كارت أ" });
    await publishPrices(1, providerId, DATE, [
      { offeringId: a, providerShare: "9500" },
    ]);
    const fresh = await mkOffering(providerId, { name: "كارت جديد" });

    const res = await withTx((tx) =>
      pricingService.copyPrevious(
        tx,
        { branchId: 1, providerId, businessDate: NEXT },
        actor,
      ),
    );
    expect(res.copiedCount).toBe(1);
    expect(res.skippedCount).toBe(1);

    const sheet = await pricingService.getMorningSheet(db(), {
      branchId: 1,
      providerId,
      businessDate: NEXT,
    });
    expect(sheet.missingCount).toBe(1);
    expect(sheet.rows.find((r) => r.offeringId === fresh)?.status).toBe(
      "NEEDS_INPUT",
    );
  });

  it("كشف الصباح بلا مسودّة يعرض السعر المُرحَّل (CARRIED_OVER)", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);

    const sheet = await pricingService.getMorningSheet(db(), {
      branchId: 1,
      providerId,
      businessDate: NEXT,
    });
    expect(sheet.batch).toBeNull();
    expect(sheet.missingCount).toBe(0);
    const row = sheet.rows[0];
    expect(row.status).toBe("CARRIED_OVER");
    expect(row.currentSellPrice).toBe("10000.00");
    expect(row.draftProviderShare).toBeNull();
  });
});

describe("ش٤ — بلاغ تغيّر السعر", () => {
  it("الكاشير يُبلّغ، والمدير يعتمد ⇒ نسخة جديدة تُنشر ولا يُعدَّل الإصدار القديم", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);
    const oldVersionId = Number(
      (await currentPrice(1, offeringId))!.priceVersionId,
    );

    const { reportId } = await withTx((tx) =>
      pricingService.reportMismatch(
        tx,
        {
          branchId: 1,
          offeringId,
          reportedProviderShare: "9750",
          notes: "الجهاز يعرض ٩٧٥٠",
        },
        actor,
      ),
    );

    const open = await pricingService.listMismatchReports(db(), {
      branchId: 1,
      status: "OPEN",
    });
    expect(open).toHaveLength(1);
    expect(open[0].reportedProviderShare).toBe("9750.00");
    expect(open[0].currentProviderShare).toBe("9500.00");

    const res = await withTx((tx) =>
      pricingService.approveMismatch(
        tx,
        {
          reportId,
          businessDate: NEXT,
          sellPrice: "10000",
        },
        actor2,
      ),
    );

    // الإصدار القديم محفوظ كما هو، والمؤشّر تحوّل للجديد.
    const [oldV] = await db()
      .select()
      .from(s.digitalPriceVersions)
      .where(eq(s.digitalPriceVersions.id, oldVersionId));
    expect(oldV.providerShare).toBe("9500.00");
    expect(oldV.validUntil).not.toBeNull();

    const live = await currentPrice(1, offeringId);
    expect(Number(live!.priceVersionId)).toBe(res.priceVersionId);
    expect(live!.providerShare).toBe("9750.00");
    expect(live!.sellPrice).toBe("10000.00");

    expect(await pricingService.openMismatchCount(db(), 1)).toBe(0);
  });

  it("الرفض لا يمسّ أيّ سعر", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);
    const { reportId } = await withTx((tx) =>
      pricingService.reportMismatch(
        tx,
        {
          branchId: 1,
          offeringId,
          reportedProviderShare: "9750",
        },
        actor,
      ),
    );

    await withTx((tx) =>
      pricingService.rejectMismatch(
        tx,
        { reportId, notes: "لا تغيير فعليّ" },
        actor2,
      ),
    );

    expect((await currentPrice(1, offeringId))!.providerShare).toBe("9500.00");
    expect(await pricingService.openMismatchCount(db(), 1)).toBe(0);
  });

  it("اعتماد البلاغ يرفض سعر بيع لا يطابق snapshot النافذ", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, DATE, [{ offeringId, providerShare: "9500" }]);
    const { reportId } = await withTx((tx) =>
      pricingService.reportMismatch(
        tx,
        { branchId: 1, offeringId, reportedProviderShare: "9750" },
        actor,
      ),
    );

    await expect(
      withTx((tx) => pricingService.approveMismatch(
        tx,
        { reportId, businessDate: NEXT, sellPrice: "9999" },
        actor2,
      )),
    ).rejects.toThrow(/لا يطابق سعر العميل/);
    expect((await currentPrice(1, offeringId))!.sellPrice).toBe("10000.00");
    expect(await pricingService.openMismatchCount(db(), 1)).toBe(1);
  });

  it("معالجة البلاغ مرّتين مرفوضة", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);
    const { reportId } = await withTx((tx) =>
      pricingService.reportMismatch(
        tx,
        {
          branchId: 1,
          offeringId,
          reportedProviderShare: "9750",
        },
        actor,
      ),
    );
    await withTx((tx) =>
      pricingService.rejectMismatch(tx, { reportId }, actor2),
    );
    await expect(
      withTx((tx) => pricingService.rejectMismatch(tx, { reportId }, actor2)),
    ).rejects.toThrow(/عولِج مسبقاً/);
  });

  it("الاعتماد يُرفض إن كانت هناك مسودّة مفتوحة لليوم نفسه (حارس فقد بيانات)", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await publishPrices(1, providerId, DATE, [
      { offeringId, providerShare: "9500" },
    ]);
    const { reportId } = await withTx((tx) =>
      pricingService.reportMismatch(
        tx,
        {
          branchId: 1,
          offeringId,
          reportedProviderShare: "9750",
        },
        actor,
      ),
    );

    // مديرٌ آخر في منتصف إدخال مسودّة الغد.
    const { batchId } = await withTx((tx) =>
      pricingService.createOrGetDraft(
        tx,
        { branchId: 1, providerId, businessDate: NEXT },
        actor2,
      ),
    );
    await withTx((tx) =>
      pricingService.saveDraft(
        tx,
        {
          batchId,
          lines: [{ offeringId, providerShare: "8888" }],
        },
        actor2,
      ),
    );

    await expect(
      withTx((tx) =>
        pricingService.approveMismatch(
          tx,
          { reportId, businessDate: NEXT, sellPrice: "10000" },
          actor2,
        ),
      ),
    ).rejects.toThrow(/مسودّة أسعار مفتوحة/);

    // مسودّة المدير الآخر سليمة ولم تُطمَس.
    const [line] = await db()
      .select()
      .from(s.digitalPriceVersions)
      .where(eq(s.digitalPriceVersions.batchId, batchId));
    expect(line.providerShare).toBe("8888.00");
  });

  it("بلاغ لبطاقة بلا سعر نافذ مرفوض", async () => {
    const providerId = await mkProvider();
    const offeringId = await mkOffering(providerId);
    await expect(
      withTx((tx) =>
        pricingService.reportMismatch(
          tx,
          {
            branchId: 1,
            offeringId,
            reportedProviderShare: "9750",
          },
          actor,
        ),
      ),
    ).rejects.toThrow(/لا سعر نافذ/);
  });
});
