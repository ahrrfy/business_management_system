import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveCostWave,
  getCostWave,
  listCostWaves,
  previewCostWave,
  rejectCostWave,
  submitCostWave,
  type PreviewCostWaveInput,
} from "../inventory/costWaveService";
import { requestCostRevaluation } from "../inventory/costRevaluationRequest";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "auditLogs",
  "journalLines",
  "journalEntries",
  "accountingEntries",
  "doubleEntrySettings",
  "costUpdateWaveEvents",
  "costUpdateWaveApprovals",
  "costUpdateWaveItems",
  "costUpdateWaves",
  "costRevaluationRequests",
  "financialPeriods",
  "branchStock",
  "productVariants",
  "products",
  "categories",
  "branches",
  "users",
];

const creator = { userId: 1, branchId: 1, role: "admin" as const };
const checker1 = { userId: 2, branchId: 1, role: "admin" as const };
const checker2 = { userId: 3, branchId: 1, role: "manager" as const };
const outsider = { userId: 4, branchId: 2, role: "manager" as const };
const globalAdmin = { userId: 2, branchId: 0, role: "admin" as const };
const globalAdmin2 = { userId: 5, branchId: 0, role: "admin" as const };
const REASON = "تصحيح تكلفة دفعة استلام أُدخلت بقيمة غير صحيحة";

function listRows<T>(result: T[] | { rows: T[] }): T[] {
  return Array.isArray(result) ? result : result.rows;
}

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function seed() {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
      { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "wave-creator",
        name: "منشئ الموجة",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "wave-checker-1",
        name: "المعتمد الأول",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "wave-checker-2",
        name: "المعتمد الثاني",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 4,
        openId: "wave-outsider",
        name: "مدير فرع آخر",
        role: "manager",
        loginMethod: "local",
        branchId: 2,
      },
      {
        id: 5,
        openId: "wave-global-admin-2",
        name: "إدارة عامة ثانية",
        role: "admin",
        loginMethod: "local",
        branchId: null,
      },
    ]);
  await db().insert(s.doubleEntrySettings).values({
    id: 1,
    mode: "SHADOW",
    shadowCycleId: "cost-wave-test-cycle",
  });
  await db()
    .insert(s.categories)
    .values([{ id: 1, name: "القرطاسية" }]);
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "قلم أزرق", categoryId: 1 },
      { id: 2, name: "دفتر", categoryId: 1 },
      { id: 3, name: "خدمة تغليف", categoryId: 1, isService: true },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "PEN-B", costPrice: "100.00" },
      { id: 2, productId: 2, sku: "NOTE-1", costPrice: "50.00" },
      { id: 3, productId: 3, sku: "SERVICE-1", costPrice: "25.00" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 1, branchId: 1, quantity: 10 },
      { variantId: 2, branchId: 1, quantity: 4 },
    ]);
}

const previewInput: PreviewCostWaveInput = {
  purpose: "CORRECTION",
  ruleType: "DECREASE_PERCENT",
  changeValue: "20",
  filters: { scope: "FILTERED", categoryId: 1 },
};

async function submittedWave() {
  const preview = await previewCostWave(previewInput, creator);
  const submitted = await submitCostWave(
    {
      ...previewInput,
      name: "تصحيح تكلفة دفعة آب",
      reason: REASON,
      description: "جرد المستندات ومطابقة فاتورة المورد",
      previewFingerprint: preview.fingerprint,
    },
    creator,
  );
  return { preview, submitted };
}

async function costs() {
  const rows = await db()
    .select({ id: s.productVariants.id, cost: s.productVariants.costPrice })
    .from(s.productVariants)
    .where(
      and(
        eq(s.productVariants.isActive, true),
        like(s.productVariants.sku, "%"),
      ),
    );
  return new Map(
    rows.map((row) => [Number(row.id), money(row.cost).toFixed(2)]),
  );
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("معاينة وإرسال موجة التكلفة", () => {
  it("تعرض المنتج والفئة والتكلفة والكميات والأثر، وتستبعد الخدمة بتفسير", async () => {
    const preview = await previewCostWave(previewInput, creator);
    expect(
      preview.rows.map((row) => [
        row.variantId,
        row.categoryName,
        row.oldCost,
        row.newCost,
      ]),
    ).toEqual([
      [1, "القرطاسية", "100.00", "80.00"],
      [2, "القرطاسية", "50.00", "40.00"],
    ]);
    expect(preview.totals).toMatchObject({
      itemCount: 2,
      skippedCount: 1,
      expectedQuantity: 14,
      inventoryValueBefore: "1200.00",
      inventoryValueAfter: "960.00",
      expectedValueDelta: "-240.00",
    });
    expect(preview.skipped[0]).toMatchObject({
      variantId: 3,
      reason: "SERVICE",
    });
  });

  it("يدعم الخفض بمبلغ ثابت ويستبعد فقط الصنف الذي سيصبح سالبا", async () => {
    const preview = await previewCostWave(
      { ...previewInput, ruleType: "DECREASE_AMOUNT", changeValue: "60" },
      creator,
    );
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      variantId: 1,
      oldCost: "100.00",
      newCost: "40.00",
    });
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: 2, reason: "NEGATIVE_RESULT" }),
        expect.objectContaining({ variantId: 3, reason: "SERVICE" }),
      ]),
    );
  });

  it("يرفض قاعدة رفع صريحة عندما يكون الغرض هبوط القيمة", async () => {
    await expect(
      previewCostWave(
        {
          ...previewInput,
          purpose: "IMPAIRMENT",
          ruleType: "INCREASE_AMOUNT",
          changeValue: "5",
        },
        creator,
      ),
    ).rejects.toThrow(/هبوط القيمة لا يرفع التكلفة/);
  });

  it("يرفض قيمة تغيير لا يمكن تخزينها في DECIMAL(15,4)", async () => {
    await expect(
      previewCostWave(
        { ...previewInput, ruleType: "SET_COST", changeValue: "100000000000" },
        creator,
      ),
    ).rejects.toThrow(/حد التخزين/);
  });

  it("يقبل التعيين في هبوط القيمة ويستبعد فقط الصفوف التي سيرفع تكلفتها", async () => {
    const preview = await previewCostWave(
      {
        ...previewInput,
        purpose: "IMPAIRMENT",
        ruleType: "SET_COST",
        changeValue: "75",
      },
      creator,
    );
    expect(preview.rows).toEqual([
      expect.objectContaining({ variantId: 1, newCost: "75.00" }),
    ]);
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: 2, reason: "IMPAIRMENT_INCREASE" }),
      ]),
    );
  });

  it("يوسّع الفئة إلى جميع الأحفاد لا الأبناء المباشرين فقط", async () => {
    await db()
      .insert(s.categories)
      .values([
        { id: 10, name: "فرعية", parentId: 1 },
        { id: 11, name: "حفيدة", parentId: 10 },
      ]);
    await db().insert(s.products).values({
      id: 4,
      name: "منتج في الفئة الحفيدة",
      categoryId: 11,
    });
    await db().insert(s.productVariants).values({
      id: 4,
      productId: 4,
      sku: "DEEP-1",
      costPrice: "30.00",
    });
    await db().insert(s.branchStock).values({
      variantId: 4,
      branchId: 1,
      quantity: 2,
    });

    const preview = await previewCostWave(previewInput, creator);
    expect(preview.rows.map((row) => row.variantId)).toContain(4);
  });

  it("الإرسال يجمّد التفاصيل واللقطة ولا يغيّر التكلفة", async () => {
    const { preview, submitted } = await submittedWave();
    expect(submitted).toEqual({
      waveId: expect.any(Number),
      status: "PENDING_APPROVAL",
      approvalCount: 0,
    });
    expect(await costs()).toEqual(
      new Map([
        [1, "100.00"],
        [2, "50.00"],
        [3, "25.00"],
      ]),
    );

    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.items).toHaveLength(2);
    expect(detail.skipped).toEqual([
      expect.objectContaining({ variantId: 3, reason: "SERVICE" }),
    ]);
    expect(detail.items[0]).toMatchObject({
      productNameSnapshot: "قلم أزرق",
      categoryNameSnapshot: "القرطاسية",
      oldCost: "100.00",
      newCost: "80.00",
      expectedQuantity: 10,
    });
    expect(detail.events.map((event) => event.stage)).toEqual(["SUBMITTED"]);
    expect(detail.events[0].snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(detail.events[0].snapshotFingerprint).not.toBe(preview.fingerprint);
  });

  it("يرفض الإرسال إن تغيرت المعاينة قبل التوقيع", async () => {
    const preview = await previewCostWave(previewInput, creator);
    await db()
      .update(s.productVariants)
      .set({ costPrice: "105.00" })
      .where(eq(s.productVariants.id, 1));
    await expect(
      submitCostWave(
        {
          ...previewInput,
          name: "موجة متغيرة",
          reason: REASON,
          previewFingerprint: preview.fingerprint,
        },
        creator,
      ),
    ).rejects.toThrow(/أعد المعاينة/);
    expect(await db().select().from(s.costUpdateWaves)).toHaveLength(0);
  });

  it("يرفض خلط فلاتر البحث مع الاختيار اليدوي بدلاً من تقاطع صامت", async () => {
    await expect(
      previewCostWave(
        {
          ...previewInput,
          filters: {
            scope: "SELECTED",
            variantIds: [1],
            productSearch: "قلم",
          },
        },
        creator,
      ),
    ).rejects.toThrow(/لا تجمع الاختيار اليدوي مع نطاق الفلاتر/);
  });

  it("يُظهر المتغيّر غير النشط أو غير الموجود ضمن الاختيار اليدوي كاستبعاد صريح", async () => {
    await db()
      .update(s.productVariants)
      .set({ isActive: false })
      .where(eq(s.productVariants.id, 2));
    const preview = await previewCostWave(
      {
        ...previewInput,
        filters: { scope: "SELECTED", variantIds: [1, 2, 999999] },
      },
      creator,
    );
    expect(preview.rows.map((row) => row.variantId)).toEqual([1]);
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: 2, reason: "INACTIVE" }),
        expect.objectContaining({ variantId: 999999, reason: "NOT_FOUND" }),
      ]),
    );
  });

  it("الإدارة العامة بلا فرع مسند ترى قائمة الاعتماد وتستطيع الاعتماد", async () => {
    const { submitted } = await submittedWave();
    const awaiting = await listCostWaves(
      { view: "AWAITING_MINE" },
      globalAdmin,
    );
    expect(listRows(awaiting).map((wave) => wave.id)).toContain(
      submitted.waveId,
    );
    await expect(
      approveCostWave(submitted.waveId, globalAdmin),
    ).resolves.toMatchObject({ status: "PENDING_APPROVAL", approvalCount: 1 });
    await expect(
      approveCostWave(submitted.waveId, globalAdmin2),
    ).resolves.toMatchObject({ status: "APPLIED", approvalCount: 2 });
  });

  it("يطبق مرشح الفرع في استعلام القائمة قبل الترقيم", async () => {
    const { submitted } = await submittedWave();
    const branchOne = await listCostWaves({ branchId: 1 }, globalAdmin);
    const branchTwo = await listCostWaves({ branchId: 2 }, globalAdmin);
    expect(listRows(branchOne).map((wave) => wave.id)).toContain(submitted.waveId);
    expect(listRows(branchTwo).map((wave) => wave.id)).not.toContain(submitted.waveId);
  });

  it("يمنع طلب إعادة تقييم فردي لنفس الصنف ما دامت الموجة معلقة", async () => {
    await submittedWave();
    await expect(
      requestCostRevaluation(
        {
          variantId: 1,
          newCost: "75.00",
          purpose: "CORRECTION",
          reason: REASON,
        },
        creator,
      ),
    ).rejects.toThrow(/موجة تكلفة معلقة/);
  });
});

describe("اعتمادان مستقلان وتطبيق ذري", () => {
  it("الاعتماد الأول يحفظ لقطة فقط، والثاني يطبق كل الأصناف والقيود", async () => {
    const { submitted } = await submittedWave();
    const first = await approveCostWave(submitted.waveId, checker1);
    expect(first).toMatchObject({
      status: "PENDING_APPROVAL",
      approvalCount: 1,
      appliedItems: 0,
    });
    expect((await costs()).get(1)).toBe("100.00");

    const second = await approveCostWave(submitted.waveId, checker2);
    expect(second).toMatchObject({
      status: "APPLIED",
      approvalCount: 2,
      appliedItems: 2,
      postedEntries: 2,
    });
    expect((await costs()).get(1)).toBe("80.00");
    expect((await costs()).get(2)).toBe("40.00");

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        like(s.accountingEntries.dedupeKey, `COST_WAVE:${submitted.waveId}:%`),
      );
    expect(entries).toHaveLength(2);
    expect(
      entries
        .reduce((sum, row) => sum.plus(money(row.profit)), money(0))
        .toFixed(2),
    ).toBe("-240.00");
    expect(entries.map((row) => row.postingProfile)).toEqual([
      "ADJUST_INVENTORY_REVALUATION_LOSS",
      "ADJUST_INVENTORY_REVALUATION_LOSS",
    ]);
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.approvals.map((approval) => approval.approverName)).toEqual([
      "المعتمد الأول",
      "المعتمد الثاني",
    ]);
    expect(detail.events.map((event) => event.stage)).toEqual([
      "SUBMITTED",
      "APPROVAL_1",
      "APPROVAL_2",
      "APPLIED",
    ]);
    expect(
      new Set(detail.events.map((event) => event.snapshotFingerprint)).size,
    ).toBe(detail.events.length);
  });

  it("المنشئ لا يعتمد ولو كان admin، والمعتمد نفسه لا يحسب مرتين", async () => {
    const { submitted } = await submittedWave();
    await expect(approveCostWave(submitted.waveId, creator)).rejects.toThrow(
      /منشئ الموجة/,
    );
    await approveCostWave(submitted.waveId, checker1);
    await expect(approveCostWave(submitted.waveId, checker1)).rejects.toThrow(
      /مسبقاً/,
    );
    expect((await costs()).get(1)).toBe("100.00");
  });

  it("انحراف صنف واحد بعد الاعتماد الأول يجعل الموجة كلها متعارضة بلا تطبيق جزئي", async () => {
    const { submitted } = await submittedWave();
    await approveCostWave(submitted.waveId, checker1);
    await db()
      .update(s.productVariants)
      .set({ costPrice: "110.00" })
      .where(eq(s.productVariants.id, 1));

    const result = await approveCostWave(submitted.waveId, checker2);
    expect(result).toMatchObject({
      status: "CONFLICTED",
      approvalCount: 1,
      appliedItems: 0,
    });
    expect((await costs()).get(1)).toBe("110.00");
    expect((await costs()).get(2)).toBe("50.00");
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(like(s.accountingEntries.dedupeKey, "COST_WAVE:%")),
    ).toHaveLength(0);
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave.status).toBe("CONFLICTED");
    expect(detail.events.at(-1)?.stage).toBe("CONFLICTED");
    expect(detail.events.at(-1)?.snapshotJson).toMatchObject({
      conflicts: [
        expect.objectContaining({ variantId: 1, reason: "COST_DRIFT" }),
      ],
    });
  });

  it("أي عبث بتفاصيل المستند بعد الإرسال تكشفه البصمة قبل أول اعتماد", async () => {
    const { submitted } = await submittedWave();
    await db()
      .update(s.costUpdateWaveItems)
      .set({ newCost: "1.00" })
      .where(
        and(
          eq(s.costUpdateWaveItems.waveId, submitted.waveId),
          eq(s.costUpdateWaveItems.variantId, 1),
        ),
      );

    const result = await approveCostWave(submitted.waveId, checker1);
    expect(result).toMatchObject({
      status: "CONFLICTED",
      approvalCount: 0,
      appliedItems: 0,
    });
    expect((await costs()).get(1)).toBe("100.00");
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave.conflictReason).toMatch(/البصمة الموقعة/);
    expect(detail.approvals).toHaveLength(0);
  });

  it("تكشف البصمة العبث بسبب المستند، وتكشف المطابقة العبث بإجماليات الرأس", async () => {
    const first = await submittedWave();
    await db()
      .update(s.costUpdateWaves)
      .set({ reason: "سبب مستبدل بعد توقيع المستند" })
      .where(eq(s.costUpdateWaves.id, first.submitted.waveId));
    await expect(
      approveCostWave(first.submitted.waveId, checker1),
    ).resolves.toMatchObject({ status: "CONFLICTED" });

    const second = await submittedWave();
    await db()
      .update(s.costUpdateWaves)
      .set({ expectedValueDelta: "1.00" })
      .where(eq(s.costUpdateWaves.id, second.submitted.waveId));
    await expect(
      approveCostWave(second.submitted.waveId, checker1),
    ).resolves.toMatchObject({ status: "CONFLICTED" });
  });

  it("قفل الفترة يُرجع الاعتماد الثاني والتكلفة والقيود معاً", async () => {
    const { submitted } = await submittedWave();
    await approveCostWave(submitted.waveId, checker1);
    const today = new Date().toISOString().slice(0, 10);
    await db()
      .insert(s.financialPeriods)
      .values({ cutoffDate: today, lockedBy: 1, status: "LOCKED" });

    await expect(approveCostWave(submitted.waveId, checker2)).rejects.toThrow(
      /الفترة المالية مُقفَلة/,
    );
    expect((await costs()).get(1)).toBe("100.00");
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave).toMatchObject({
      status: "PENDING_APPROVAL",
      approvalCount: 1,
    });
    expect(detail.approvals).toHaveLength(1);
    expect(detail.events.map((event) => event.stage)).toEqual([
      "SUBMITTED",
      "APPROVAL_1",
    ]);
  });

  it("تعطيل المنتج بعد الاعتماد الأول يجعل الموجة متعارضة بلا تطبيق", async () => {
    const { submitted } = await submittedWave();
    await approveCostWave(submitted.waveId, checker1);
    await db()
      .update(s.products)
      .set({ isActive: false })
      .where(eq(s.products.id, 1));

    await expect(
      approveCostWave(submitted.waveId, checker2),
    ).resolves.toMatchObject({ status: "CONFLICTED", appliedItems: 0 });
    expect((await costs()).get(1)).toBe("100.00");
  });

  it("أي فشل في ترحيل صنف يعيد كل تغييرات الموجة والقرار الثاني", async () => {
    const { submitted } = await submittedWave();
    await approveCostWave(submitted.waveId, checker1);
    await db().insert(s.accountingEntries).values({
      entryType: "ADJUST",
      branchId: 1,
      entryDate: new Date().toISOString().slice(0, 10),
      dedupeKey: `COST_WAVE:${submitted.waveId}:2:1`,
    });

    await expect(
      approveCostWave(submitted.waveId, checker2),
    ).rejects.toThrow();
    expect((await costs()).get(1)).toBe("100.00");
    expect((await costs()).get(2)).toBe("50.00");
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave).toMatchObject({
      status: "PENDING_APPROVAL",
      approvalCount: 1,
    });
    expect(detail.approvals).toHaveLength(1);
    expect(detail.events.map((event) => event.stage)).toEqual([
      "SUBMITTED",
      "APPROVAL_1",
    ]);
  });
});

describe("الرفض والعزل", () => {
  it("يحفظ الرافض والتاريخ والسبب بلا أثر مالي", async () => {
    const { submitted } = await submittedWave();
    await rejectCostWave(
      submitted.waveId,
      "المستند الداعم لا يطابق فاتورة المورد",
      checker1,
    );
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave.status).toBe("REJECTED");
    expect(detail.approvals[0]).toMatchObject({
      approverName: "المعتمد الأول",
      decision: "REJECTED",
      reason: "المستند الداعم لا يطابق فاتورة المورد",
    });
    expect(detail.events.at(-1)?.stage).toBe("REJECTED");
    expect((await costs()).get(1)).toBe("100.00");
  });

  it("مدير الفرع الآخر لا يرى تفاصيل الموجة ولا يعتمدها", async () => {
    const { submitted } = await submittedWave();
    await expect(getCostWave(submitted.waveId, outsider)).rejects.toThrow(
      /فرعاً آخر/,
    );
    await expect(approveCostWave(submitted.waveId, outsider)).rejects.toThrow(
      /فرعاً آخر/,
    );
  });

  it("الموجة متعددة الفروع لا تظهر لمدير فرعها الاسمي ولا يقررها", async () => {
    await db().insert(s.branchStock).values({
      variantId: 1,
      branchId: 2,
      quantity: 3,
    });
    const preview = await previewCostWave(previewInput, creator);
    const submitted = await submitCostWave(
      {
        ...previewInput,
        name: "موجة تكلفة متعددة الفروع",
        reason: REASON,
        previewFingerprint: preview.fingerprint,
      },
      creator,
    );

    const awaiting = await listCostWaves(
      { view: "AWAITING_MINE" },
      checker2,
    );
    expect(listRows(awaiting).map((wave) => wave.id)).not.toContain(
      submitted.waveId,
    );
    await expect(getCostWave(submitted.waveId, checker2)).rejects.toThrow(
      /الإدارة العامة|فروع/,
    );
    await expect(
      rejectCostWave(submitted.waveId, REASON, checker2),
    ).rejects.toThrow(/الإدارة العامة|فروع/);
  });

  it("سياسة المالك تُبقي مراجعين مستقلين وتجعل المالك المعتمد النهائي", async () => {
    const previous = process.env.ROLLOUT_OWNER_ONLY_APPROVAL;
    process.env.ROLLOUT_OWNER_ONLY_APPROVAL = "ON";
    try {
      await db()
        .update(s.users)
        .set({ isOwner: true })
        .where(eq(s.users.id, checker2.userId));
      const { submitted } = await submittedWave();
      await expect(
        approveCostWave(submitted.waveId, checker2),
      ).rejects.toThrow(/الخطوة النهائية/);
      await expect(
        approveCostWave(submitted.waveId, checker1),
      ).resolves.toMatchObject({ status: "PENDING_APPROVAL", approvalCount: 1 });
      await expect(
        approveCostWave(submitted.waveId, checker1),
      ).rejects.toThrow(/مسبقاً/);
      await expect(
        approveCostWave(submitted.waveId, checker2),
      ).resolves.toMatchObject({ status: "APPLIED", approvalCount: 2 });
    } finally {
      if (previous === undefined)
        delete process.env.ROLLOUT_OWNER_ONLY_APPROVAL;
      else process.env.ROLLOUT_OWNER_ONLY_APPROVAL = previous;
    }
  });

  it("سبب رفض بطول العقد العام 1000 محرف يُحفظ بلا قطع", async () => {
    const { submitted } = await submittedWave();
    const reason = "س".repeat(900);
    await rejectCostWave(submitted.waveId, reason, checker1);
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave.rejectionReason).toBe(reason);
    expect(detail.approvals[0]?.reason).toBe(reason);
  });
});

describe("حماية الحجز من السباقات", () => {
  it("إرسالان متزامنان على الأصناف نفسها لا ينشئان موجتين معلقتين", async () => {
    const preview = await previewCostWave(previewInput, creator);
    const makeInput = (suffix: string) => ({
      ...previewInput,
      name: `موجة متزامنة ${suffix}`,
      reason: REASON,
      previewFingerprint: preview.fingerprint,
    });
    const results = await Promise.allSettled([
      submitCostWave(makeInput("أ"), creator),
      submitCostWave(makeInput("ب"), creator),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const pending = await db()
      .select()
      .from(s.costUpdateWaves)
      .where(eq(s.costUpdateWaves.status, "PENDING_APPROVAL"));
    expect(pending).toHaveLength(1);
  });
});
