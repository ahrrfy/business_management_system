/**
 * إفصاح التوصيل المجّاني (هجرة 0152) — قرار المالك ٥/٨/٢٦: «ميّز التوصيل المجّاني عن بلا توصيل
 * في الفاتورة، مع كافة المعلومات بشفافية تامة».
 *
 * قبلها: كلتا الحالتين `deliveryFee = 0` فلا تُفرَّقان — لا الزبون يرى أنّك تنازلتَ له عن
 * الأجرة، ولا التقارير تعرف كم توصيلاً أُهدي. بعدها **ثلاث حالات صريحة**:
 *   بلا توصيل   ⇒ deliveryFree=0, deliveryFee=0, waived=0      (لا سطر توصيل)
 *   توصيل مدفوع ⇒ deliveryFee>0                                 (إيرادٌ يدخل SALE والإجمالي)
 *   توصيل مجّاني ⇒ deliveryFree=1 + waived=قيمته                 (بلا إيراد وبلا إجمالي)
 *
 * الثابت المالي المحروس: العَلَم والقيمة المُتنازَل عنها **إفصاحٌ لا محاسبة** — لا يزيدان
 * `total` ولا `revenue` ولا يُنشئان قيداً. لو تسرّبا إلى الإيراد لظهر ربحٌ من توصيلٍ مجّانيّ.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";

const actor = { userId: 1, branchId: 1, role: "admin" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
    "branchStock", "productPrices", "productUnits", "productVariants", "products", "shifts", "customers", "branches", "users",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([{ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" }]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  await d.insert(s.customers).values({ id: 1, name: "زبون", defaultPriceTier: "RETAIL", currentBalance: "0" });
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

beforeEach(async () => { await reset(); await seed(); });

/** بيع ٥ أقلام (٥٠ د.ع بضاعة) مع خيارات توصيل. */
async function sell(extra: Record<string, unknown>) {
  return createSale(
    {
      branchId: 1, customerId: 1, sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
      ...extra,
    },
    actor,
  );
}
async function inv(id: number) {
  return (await db().select().from(s.invoices).where(eq(s.invoices.id, id)))[0];
}
async function saleEntry(id: number) {
  return (await db().select().from(s.accountingEntries)
    .where(and(eq(s.accountingEntries.invoiceId, id), eq(s.accountingEntries.entryType, "SALE"))))[0];
}

describe("إفصاح التوصيل — ثلاث حالات متمايزة", () => {
  it("بلا توصيل: العَلَم صفر والقيمة صفر (سلوكٌ غير متغيّر — حارس انحدار)", async () => {
    const r = await sell({});
    const i = await inv(r.invoiceId);
    expect(Number(i.deliveryFee)).toBe(0);
    expect(Number(i.deliveryFree)).toBe(0);
    expect(Number(i.deliveryWaivedAmount)).toBe(0);
    expect(Number(i.total)).toBeCloseTo(50, 2);
  });

  it("توصيل مدفوع: أجرةٌ تدخل الإجمالي والإيراد، والعَلَم يبقى صفراً", async () => {
    const r = await sell({ deliveryFee: "3000" });
    const i = await inv(r.invoiceId);
    expect(Number(i.deliveryFee)).toBeCloseTo(3000, 2);
    expect(Number(i.deliveryFree)).toBe(0);
    expect(Number(i.total)).toBeCloseTo(3050, 2);
    expect(Number((await saleEntry(r.invoiceId)).revenue)).toBeCloseTo(3050, 2);
  });

  it("توصيل مجّاني: يُميَّز بالعَلَم وتُحفَظ قيمته — بلا إيراد وبلا إجمالي", async () => {
    const r = await sell({ deliveryFree: true, deliveryWaivedAmount: "3000" });
    const i = await inv(r.invoiceId);
    expect(Number(i.deliveryFree)).toBe(1);
    expect(Number(i.deliveryWaivedAmount)).toBeCloseTo(3000, 2); // ما تنازلنا عنه — يراه الزبون
    expect(Number(i.deliveryFee)).toBe(0); // لا أجرة تُقبض
    expect(Number(i.total)).toBeCloseTo(50, 2); // البضاعة وحدها
    // **الثابت الحاكم**: الإفصاح لا يُنتج إيراداً — وإلّا ظهر ربحٌ من توصيلٍ مجّانيّ.
    expect(Number((await saleEntry(r.invoiceId)).revenue)).toBeCloseTo(50, 2);
  });

  it("مجّانيّ بلا قيمة مذكورة: العَلَم يكفي للتمييز عن «بلا توصيل»", async () => {
    const r = await sell({ deliveryFree: true });
    const i = await inv(r.invoiceId);
    expect(Number(i.deliveryFree)).toBe(1);
    expect(Number(i.deliveryWaivedAmount)).toBe(0);
    expect(Number(i.total)).toBeCloseTo(50, 2);
  });

  it("تناقضٌ محسوم خادمياً: عَلَمٌ مع أجرةٍ موجبة ⇒ الأجرة تُغلِّب والعَلَم يسقط", async () => {
    // لا يصحّ أن تقول الفاتورة «التوصيل مجاناً» وتقبض أجرته في آنٍ واحد.
    const r = await sell({ deliveryFree: true, deliveryFee: "3000", deliveryWaivedAmount: "3000" });
    const i = await inv(r.invoiceId);
    expect(Number(i.deliveryFree)).toBe(0);
    expect(Number(i.deliveryFee)).toBeCloseTo(3000, 2);
    expect(Number(i.deliveryWaivedAmount)).toBe(0); // لا تُخزَّن إلّا مع مجّانيّةٍ فعلية
    expect(Number(i.total)).toBeCloseTo(3050, 2);
  });

  it("قيمة مُتنازَل عنها سالبة ⇒ ترفض", async () => {
    await expect(sell({ deliveryFree: true, deliveryWaivedAmount: "-1" })).rejects.toThrow(/سالبة/);
  });
});
