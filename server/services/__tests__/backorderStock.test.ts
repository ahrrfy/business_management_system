import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { applyMovement } from "../inventoryService";

/**
 * «يُباع بالطلب» (هجرة 0318) — بيعٌ قبل التوريد لصنفٍ مخزنيّ يُغذَّى لاحقاً.
 *
 * الحالة (بلاغ المالك ٣١/٨): عملُ طباعةٍ يُباع للزبون ثمّ يُوفَّر — إمّا شراءً جاهزاً من مطبعة
 * أخرى، أو إنتاجاً داخلياً بوصفة الصنف. الطريقان كانا يعملان أصلاً؛ الناقص وحده كان السماح
 * بالبيع **قبل** التغذية، فيظهر «نافذ» وتُرفض الفاتورة أمام الزبون.
 *
 * ⭐ **الحالة الحاسمة هنا هي (٣): دوامُ الإعفاء.** البديلان القائمان يعملان في الدورة الأولى
 * ثمّ ينكسران بصمت في الثانية — `allowNegativeUnopened` مشروطٌ بـ`openedAt IS NULL`، وأوّل
 * استلامِ شراءٍ يَسِم الصنف مُفتتَحاً (`stampOpened`) فيعود الرفض؛ و«وضع الافتتاح» نافذةٌ
 * ≤٦٠ يوماً تنتهي. اختبارٌ يفحص الدورة الأولى وحدها كان سيمرّ أخضرَ على ميزةٍ معطوبة.
 */

const TABLES = [
  "auditLogs",
  "inventoryMovements",
  "reservationStock",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "users",
  "branches",
];

const STOCKED = 1; // صنفٌ عاديّ — الحارس الصارم
const BACKORDER = 2; // «يُباع بالطلب»

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
  await d
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({
    id: 1,
    openId: "local_admin",
    name: "المدير",
    email: "admin@m.test",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await d.insert(s.products).values([
    { id: STOCKED, name: "دفتر ٤٠ ورقة" },
    {
      id: BACKORDER,
      name: "طباعة بوستر A0 (تُجهَّز خارجياً)",
      allowBackorder: true,
    },
  ]);
  await d.insert(s.productVariants).values([
    { id: STOCKED, productId: STOCKED, sku: "NOTE-40", costPrice: "500.00" },
    {
      id: BACKORDER,
      productId: BACKORDER,
      sku: "PRINT-A0",
      costPrice: "7000.00",
    },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: STOCKED,
      variantId: STOCKED,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: BACKORDER,
      variantId: BACKORDER,
      unitName: "نسخة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
  // كلاهما برصيد صفر — نقطة البدء التي كانت تُظهر «نافذ» وتمنع الفاتورة.
  await d.insert(s.branchStock).values([
    { variantId: STOCKED, branchId: 1, quantity: 0 },
    { variantId: BACKORDER, branchId: 1, quantity: 0 },
  ]);
}

const sell = (
  variantId: number,
  qty: number,
  extra: Record<string, unknown> = {},
) =>
  withTx((tx) =>
    applyMovement(tx, {
      variantId,
      branchId: 1,
      baseQuantity: qty,
      movementType: "OUT",
      referenceType: "INVOICE",
      referenceId: 1,
      createdBy: 1,
      ...extra,
    }),
  );

const qtyOf = async (variantId: number) =>
  (
    await db()
      .select({ q: s.branchStock.quantity })
      .from(s.branchStock)
      .where(
        and(
          eq(s.branchStock.variantId, variantId),
          eq(s.branchStock.branchId, 1),
        ),
      )
      .limit(1)
  )[0]?.q ?? 0;

describe("يُباع بالطلب — حارس النفاد", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("الصنف العاديّ برصيد صفر يُرفض بيعه — الإعفاء لا يتسرّب لبقيّة الكتالوج", async () => {
    await expect(sell(STOCKED, 3)).rejects.toThrow(/المخزون غير كافٍ/);
    expect(await qtyOf(STOCKED)).toBe(0);
  });

  it("الصنف المُسنَد يُباع برصيد صفر وينزل بالسالب — عدّادُ «مُباعٌ لم يُورَّد»", async () => {
    await sell(BACKORDER, 3);
    expect(await qtyOf(BACKORDER)).toBe(-3);
  });

  it("⭐ الإعفاء دائم: يبقى نافذاً بعد أن يُوسَم الصنف مُفتتَحاً (openedAt) — وهو ما يكسر allowNegativeUnopened", async () => {
    // نُحاكي أثر أوّل استلامِ شراءٍ: `stampOpened` يختم openedAt فيقفل مسار «وضع الافتتاح».
    await db()
      .update(s.branchStock)
      .set({ openedAt: new Date() })
      .where(
        and(
          eq(s.branchStock.variantId, BACKORDER),
          eq(s.branchStock.branchId, 1),
        ),
      );

    await sell(BACKORDER, 2);
    expect(await qtyOf(BACKORDER)).toBe(-2);
  });

  it("الحركة تُوسَم «بيع بالطلب» — سالبٌ مقصود يجب أن يُقرأ كذلك في كشف الحركة لا كعجزٍ مجهول", async () => {
    await sell(BACKORDER, 1);
    const [mv] = await db()
      .select({ notes: s.inventoryMovements.notes })
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.variantId, BACKORDER))
      .limit(1);
    expect(mv?.notes ?? "").toContain("بيع بالطلب");
  });

  it("التوريد يُعيد العدّاد إلى الصفر — سواءٌ جاء شراءً من مورّد أو إنتاجاً داخلياً", async () => {
    await sell(BACKORDER, 4);
    expect(await qtyOf(BACKORDER)).toBe(-4);

    await withTx((tx) =>
      applyMovement(tx, {
        variantId: BACKORDER,
        branchId: 1,
        baseQuantity: 4,
        movementType: "IN",
        referenceType: "PURCHASE_ORDER",
        referenceId: 1,
        createdBy: 1,
        stampOpened: true,
      }),
    );
    expect(await qtyOf(BACKORDER)).toBe(0);
  });

  it("يعبر حاجز الحجوزات — وإلّا بقي محجوباً كلّما وُجد حجزٌ قائم، وهو نقيض معنى الصفة", async () => {
    await db()
      .update(s.branchStock)
      .set({ quantity: 5 })
      .where(
        and(
          eq(s.branchStock.variantId, BACKORDER),
          eq(s.branchStock.branchId, 1),
        ),
      );
    await db()
      .insert(s.reservationStock)
      .values({ variantId: BACKORDER, branchId: 1, reservedBase: 5 });

    await sell(BACKORDER, 5);
    expect(await qtyOf(BACKORDER)).toBe(0);
  });

  it("تجاوز أرضية السالب يُوسَم ولا يُرفض — الرفض هنا يُعيد نصب الحاجز بعد التزام الموظّف للزبون", async () => {
    const cap = 100; // الافتراضيّ حين لا صفّ لإعدادات وضع الافتتاح.
    await sell(BACKORDER, cap + 5);
    expect(await qtyOf(BACKORDER)).toBe(-(cap + 5));

    const [mv] = await db()
      .select({ notes: s.inventoryMovements.notes })
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.variantId, BACKORDER))
      .limit(1);
    expect(mv?.notes ?? "").toContain("تجاوز حدّ السالب");
  });
});
