/**
 * override العتبات على مستوى الفرع (P1-#4، تقرير المراجعة ٢٥/٨).
 *
 * قبل الإصلاح: `productVariants.minStock`/`reorderPoint` عالميّة ⇒ فرعٌ سريعُ الدوران وآخر بطيءٌ
 * يتلقّيان نفس التنبيه. الإصلاح: جدولُ `variantBranchThresholds` يحمل override لكل (متغيّر ×
 * فرع)، والقارئ الرئيس `listReorderAlerts` يستعمل COALESCE(override, default). القارئ العامّ
 * (dashboard/reports) يبقى على الافتراض حتى يُطلَب توسيعُه.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  clearBranchThresholds,
  countReorderAlerts,
  listBranchThresholds,
  listReorderAlerts,
  setBranchThresholds,
  setReorderThresholds,
} from "../inventory/reorder";

const TABLES = [
  "variantBranchThresholds",
  "branchStock",
  "productVariants",
  "products",
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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي (سريع)", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات (بطيء)", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({
    id: 1,
    openId: "u-admin",
    name: "أدمن",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  // الافتراض العامّ = 10 (يُنبَّه عليه فرعان معاً برصيد 5).
  await d.insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "PEN-1",
    minStock: 5,
    reorderPoint: 10,
    costPrice: "100.00",
  });
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 5 },
    { variantId: 1, branchId: 2, quantity: 5 },
  ]);
}

const actor = { userId: 1, branchId: 1, role: "admin" };

beforeEach(async () => {
  await reset();
  await seed();
});

describe("قائمةُ التنبيهات — الافتراضُ العام (لا override)", () => {
  it("الفرعان يظهران معاً تحت العتبة الافتراضيّة 10", async () => {
    const rows = await listReorderAlerts({ branchId: null });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.reorderPoint).toBe(10);
      expect(r.minStock).toBe(5);
      expect(r.overrideActive).toBe(false);
    }
  });

  it("العدّاد يوافق الطول", async () => {
    expect(await countReorderAlerts({})).toBe(2);
  });
});

describe("override فرعيّ يسود على الافتراض", () => {
  it("رفعُ عتبة الفرع البطيء يُبقيه فوق الحدّ فيختفي من التنبيهات", async () => {
    // نرفعه إلى 3 فقط ⇒ الرصيد 5 > 3 ⇒ يخرج من التنبيهات.
    await setBranchThresholds({ variantId: 1, branchId: 2, minStock: 2, reorderPoint: 3 }, actor);
    const rows = await listReorderAlerts({ branchId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0].branchId).toBe(1);
    expect(rows[0].reorderPoint).toBe(10);
    expect(rows[0].overrideActive).toBe(false);
    expect(await countReorderAlerts({})).toBe(1);
  });

  it("خفضُ عتبة فرعٍ (بلا لمس الآخر) ⇒ يظهر مبكّراً بينما الآخر لا يزال آمناً", async () => {
    // نرفع رصيد فرع ٢ إلى 8 كي يكون آمناً افتراضياً (8 < 10 = تحت الحدّ).
    // ثمّ override لفرع ٢ عتبةً 6 ⇒ 8 > 6 ⇒ يخرج.
    await db().update(s.branchStock)
      .set({ quantity: 8 })
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 2)));
    await setBranchThresholds({ variantId: 1, branchId: 2, minStock: 3, reorderPoint: 6 }, actor);
    const rows = await listReorderAlerts({ branchId: null });
    // فرع ١ (رصيد ٥ ≤ الافتراض ١٠) يبقى، فرع ٢ (رصيد ٨ > override ٦) يخرج.
    expect(rows.map((r) => r.branchId)).toEqual([1]);
  });

  it("override بشارة overrideActive صريحة يُميّزها في الشاشة", async () => {
    await setBranchThresholds({ variantId: 1, branchId: 1, minStock: 4, reorderPoint: 8 }, actor);
    const rows = await listReorderAlerts({ branchId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].overrideActive).toBe(true);
    expect(rows[0].reorderPoint).toBe(8);
    expect(rows[0].minStock).toBe(4);
  });

  it("override بحقلٍ واحد فقط (min NULL) ⇒ min يرث الافتراضَ العام", async () => {
    await setBranchThresholds({ variantId: 1, branchId: 1, minStock: null, reorderPoint: 15 }, actor);
    const rows = await listReorderAlerts({ branchId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].reorderPoint).toBe(15);
    // COALESCE(NULL, 5) = 5 — الافتراض على المتغيّر.
    expect(rows[0].minStock).toBe(5);
  });

  it("upsert: نداءُ set على نفس الفرع مرّتين يُحدّث لا يُدرج", async () => {
    await setBranchThresholds({ variantId: 1, branchId: 1, minStock: 2, reorderPoint: 4 }, actor);
    await setBranchThresholds({ variantId: 1, branchId: 1, minStock: 3, reorderPoint: 6 }, actor);
    const list = await listBranchThresholds({ branchId: 1 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ minStock: 3, reorderPoint: 6 });
  });

  it("set بكلا الحقلَين NULL ⇒ إزالةُ الصفّ (نظافةُ الجدول)", async () => {
    await setBranchThresholds({ variantId: 1, branchId: 1, minStock: 2, reorderPoint: 4 }, actor);
    const cleared = await setBranchThresholds(
      { variantId: 1, branchId: 1, minStock: null, reorderPoint: null },
      actor,
    );
    expect(cleared.cleared).toBe(true);
    expect(await listBranchThresholds({ branchId: 1 })).toHaveLength(0);
    // العتبةُ الفعّالة عادت إلى الافتراض العام.
    const rows = await listReorderAlerts({ branchId: 1 });
    expect(rows[0].reorderPoint).toBe(10);
    expect(rows[0].overrideActive).toBe(false);
  });

  it("clearBranchThresholds مسحٌ صريح — API مستقلّ للشاشة", async () => {
    await setBranchThresholds({ variantId: 1, branchId: 1, minStock: 2, reorderPoint: 4 }, actor);
    const res = await clearBranchThresholds({ variantId: 1, branchId: 1 });
    expect(res.cleared).toBe(true);
    expect(await listBranchThresholds({ branchId: 1 })).toHaveLength(0);
  });

  it("رفض: min > reorder (كلاهما مذكور)", async () => {
    await expect(
      setBranchThresholds({ variantId: 1, branchId: 1, minStock: 20, reorderPoint: 5 }, actor),
    ).rejects.toThrow(/غير صالح/);
  });

  // Codex P2 (٢٥/٨): {min: null, reorderPoint: 3} + الافتراض min=5 ⇒ الفعّال 5 > 3.
  // كان الفحص السابق يمرّ لأنّ أحد الطرفَين null. الفحص الآن على الزوج **الفعّال**.
  it("رفض: override جزئيّ (reorderPoint فقط) يخلق زوجاً فعّالاً غير صالح", async () => {
    // الافتراض: min=5, reorderPoint=10. نُمرّر reorderPoint=3 بلا min ⇒ فعّال 5 > 3.
    await expect(
      setBranchThresholds({ variantId: 1, branchId: 1, minStock: null, reorderPoint: 3 }, actor),
    ).rejects.toThrow(/غير صالح/);
  });

  it("قبول: override جزئيّ يبقى صالحاً بالوراثة (min NULL، reorder=6 مع افتراض min=5)", async () => {
    // 5 ≤ 6 ⇒ صالح.
    const res = await setBranchThresholds({ variantId: 1, branchId: 1, minStock: null, reorderPoint: 6 }, actor);
    expect(res.reorderPoint).toBe(6);
    expect(res.minStock).toBeNull();
  });

  it("رفض: قيمة سالبة", async () => {
    await expect(
      setBranchThresholds({ variantId: 1, branchId: 1, minStock: -1, reorderPoint: 5 }, actor),
    ).rejects.toThrow(/غير سالب/);
  });

  it("رفض: متغيّر/فرع غير موجود", async () => {
    await expect(
      setBranchThresholds({ variantId: 999, branchId: 1, minStock: 1, reorderPoint: 5 }, actor),
    ).rejects.toThrow(/المتغيّر غير موجود/);
    await expect(
      setBranchThresholds({ variantId: 1, branchId: 999, minStock: 1, reorderPoint: 5 }, actor),
    ).rejects.toThrow(/الفرع غير موجود/);
  });
});

describe("Codex P2: تغييرُ الافتراض العامّ يُبطِل overrides جزئيّاً", () => {
  it("رفضٌ صريحٌ عند تحديث الافتراض بشكلٍ يجعل overrides موروثةَ الحقل غير صالحة", async () => {
    // نُنشئ override جزئيّاً: {reorderPoint: 6, min: null} — الفعّال 5 (الافتراض) ≤ 6 ⇒ صالح.
    await setBranchThresholds({ variantId: 1, branchId: 1, minStock: null, reorderPoint: 6 }, actor);
    // نحاول رفع الافتراض العامّ إلى min=8 ⇒ الفعّال للـoverride يصير 8 > 6 ⇒ يُبطِله.
    await expect(
      setReorderThresholds({ variantId: 1, minStock: 8, reorderPoint: 10 }),
    ).rejects.toThrow(/يُبطِل overrides|الفروع/);
  });

  it("يقبل تحديث الافتراض إن بقيت كلّ overrides صالحة", async () => {
    await setBranchThresholds({ variantId: 1, branchId: 1, minStock: null, reorderPoint: 12 }, actor);
    // رفع min=8، الفعّال للـoverride يصير 8 ≤ 12 ⇒ يبقى صالحاً.
    const res = await setReorderThresholds({ variantId: 1, minStock: 8, reorderPoint: 15 });
    expect(res.minStock).toBe(8);
    expect(res.reorderPoint).toBe(15);
  });
});
