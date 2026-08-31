import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveCostWave,
  getCostWave,
  previewCostWave,
  rejectCostWave,
  submitCostWave,
  type PreviewCostWaveInput,
} from "../inventory/costWaveService";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "auditLogs",
  "accountingEntries",
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
const REASON = "تصحيح تكلفة دفعة استلام أُدخلت بقيمة غير صحيحة";

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

async function seed() {
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "wave-creator", name: "منشئ الموجة", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "wave-checker-1", name: "المعتمد الأول", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "wave-checker-2", name: "المعتمد الثاني", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "wave-outsider", name: "مدير فرع آخر", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await db().insert(s.categories).values([{ id: 1, name: "القرطاسية" }]);
  await db().insert(s.products).values([
    { id: 1, name: "قلم أزرق", categoryId: 1 },
    { id: 2, name: "دفتر", categoryId: 1 },
    { id: 3, name: "خدمة تغليف", categoryId: 1, isService: true },
  ]);
  await db().insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-B", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "NOTE-1", costPrice: "50.00" },
    { id: 3, productId: 3, sku: "SERVICE-1", costPrice: "25.00" },
  ]);
  await db().insert(s.branchStock).values([
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
    .where(and(eq(s.productVariants.isActive, true), like(s.productVariants.sku, "%")));
  return new Map(rows.map((row) => [Number(row.id), money(row.cost).toFixed(2)]));
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("معاينة وإرسال موجة التكلفة", () => {
  it("تعرض المنتج والفئة والتكلفة والكميات والأثر، وتستبعد الخدمة بتفسير", async () => {
    const preview = await previewCostWave(previewInput, creator);
    expect(preview.rows.map((row) => [row.variantId, row.categoryName, row.oldCost, row.newCost])).toEqual([
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
    expect(preview.skipped[0]).toMatchObject({ variantId: 3, reason: "SERVICE" });
  });

  it("الإرسال يجمّد التفاصيل واللقطة ولا يغيّر التكلفة", async () => {
    const { preview, submitted } = await submittedWave();
    expect(submitted).toEqual({ waveId: expect.any(Number), status: "PENDING_APPROVAL", approvalCount: 0 });
    expect(await costs()).toEqual(new Map([[1, "100.00"], [2, "50.00"], [3, "25.00"]]));

    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0]).toMatchObject({
      productNameSnapshot: "قلم أزرق",
      categoryNameSnapshot: "القرطاسية",
      oldCost: "100.00",
      newCost: "80.00",
      expectedQuantity: 10,
    });
    expect(detail.events.map((event) => event.stage)).toEqual(["SUBMITTED"]);
    expect(detail.events[0].snapshotFingerprint).toBe(preview.fingerprint);
  });

  it("يرفض الإرسال إن تغيرت المعاينة قبل التوقيع", async () => {
    const preview = await previewCostWave(previewInput, creator);
    await db().update(s.productVariants).set({ costPrice: "105.00" }).where(eq(s.productVariants.id, 1));
    await expect(
      submitCostWave(
        { ...previewInput, name: "موجة متغيرة", reason: REASON, previewFingerprint: preview.fingerprint },
        creator,
      ),
    ).rejects.toThrow(/أعد المعاينة/);
    expect(await db().select().from(s.costUpdateWaves)).toHaveLength(0);
  });
});

describe("اعتمادان مستقلان وتطبيق ذري", () => {
  it("الاعتماد الأول يحفظ لقطة فقط، والثاني يطبق كل الأصناف والقيود", async () => {
    const { submitted } = await submittedWave();
    const first = await approveCostWave(submitted.waveId, checker1);
    expect(first).toMatchObject({ status: "PENDING_APPROVAL", approvalCount: 1, appliedItems: 0 });
    expect((await costs()).get(1)).toBe("100.00");

    const second = await approveCostWave(submitted.waveId, checker2);
    expect(second).toMatchObject({ status: "APPLIED", approvalCount: 2, appliedItems: 2, postedEntries: 2 });
    expect((await costs()).get(1)).toBe("80.00");
    expect((await costs()).get(2)).toBe("40.00");

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(like(s.accountingEntries.dedupeKey, `COST_WAVE:${submitted.waveId}:%`));
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, row) => sum.plus(money(row.profit)), money(0)).toFixed(2)).toBe("-240.00");
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.approvals.map((approval) => approval.approverName)).toEqual(["المعتمد الأول", "المعتمد الثاني"]);
    expect(detail.events.map((event) => event.stage)).toEqual([
      "SUBMITTED",
      "APPROVAL_1",
      "APPROVAL_2",
      "APPLIED",
    ]);
  });

  it("المنشئ لا يعتمد ولو كان admin، والمعتمد نفسه لا يحسب مرتين", async () => {
    const { submitted } = await submittedWave();
    await expect(approveCostWave(submitted.waveId, creator)).rejects.toThrow(/منشئ الموجة/);
    await approveCostWave(submitted.waveId, checker1);
    await expect(approveCostWave(submitted.waveId, checker1)).rejects.toThrow(/مسبقاً/);
    expect((await costs()).get(1)).toBe("100.00");
  });

  it("انحراف صنف واحد بعد الاعتماد الأول يجعل الموجة كلها متعارضة بلا تطبيق جزئي", async () => {
    const { submitted } = await submittedWave();
    await approveCostWave(submitted.waveId, checker1);
    await db().update(s.productVariants).set({ costPrice: "110.00" }).where(eq(s.productVariants.id, 1));

    const result = await approveCostWave(submitted.waveId, checker2);
    expect(result).toMatchObject({ status: "CONFLICTED", approvalCount: 1, appliedItems: 0 });
    expect((await costs()).get(1)).toBe("110.00");
    expect((await costs()).get(2)).toBe("50.00");
    expect(
      await db().select().from(s.accountingEntries).where(like(s.accountingEntries.dedupeKey, "COST_WAVE:%")),
    ).toHaveLength(0);
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave.status).toBe("CONFLICTED");
    expect(detail.events.at(-1)?.stage).toBe("CONFLICTED");
    expect(detail.events.at(-1)?.snapshotJson).toMatchObject({
      conflicts: [expect.objectContaining({ variantId: 1, reason: "COST_DRIFT" })],
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
    expect(result).toMatchObject({ status: "CONFLICTED", approvalCount: 0, appliedItems: 0 });
    expect((await costs()).get(1)).toBe("100.00");
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave.conflictReason).toMatch(/البصمة الموقعة/);
    expect(detail.approvals).toHaveLength(0);
  });

  it("قفل الفترة يُرجع الاعتماد الثاني والتكلفة والقيود معاً", async () => {
    const { submitted } = await submittedWave();
    await approveCostWave(submitted.waveId, checker1);
    const today = new Date().toISOString().slice(0, 10);
    await db().insert(s.financialPeriods).values({ cutoffDate: today, lockedBy: 1, status: "LOCKED" });

    await expect(approveCostWave(submitted.waveId, checker2)).rejects.toThrow(/الفترة المالية مُقفَلة/);
    expect((await costs()).get(1)).toBe("100.00");
    const detail = await getCostWave(submitted.waveId, creator);
    expect(detail.wave).toMatchObject({ status: "PENDING_APPROVAL", approvalCount: 1 });
    expect(detail.approvals).toHaveLength(1);
    expect(detail.events.map((event) => event.stage)).toEqual(["SUBMITTED", "APPROVAL_1"]);
  });
});

describe("الرفض والعزل", () => {
  it("يحفظ الرافض والتاريخ والسبب بلا أثر مالي", async () => {
    const { submitted } = await submittedWave();
    await rejectCostWave(submitted.waveId, "المستند الداعم لا يطابق فاتورة المورد", checker1);
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
    await expect(getCostWave(submitted.waveId, outsider)).rejects.toThrow(/فرعاً آخر/);
    await expect(approveCostWave(submitted.waveId, outsider)).rejects.toThrow(/فرعاً آخر/);
  });
});
