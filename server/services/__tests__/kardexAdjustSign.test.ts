// INV-001 (تدقيق ٢٠/٦): بطاقة الصنف (Kardex) كانت تَحسب ADJUST موجباً دائماً (signOf→+1) بينما
// setStock يخزّن |الدلتا| والاتجاه في علامة النص «(فرق ±D)» ⇒ تسوية هابطة تَنفخ الرصيد المعروض.
// بعد الإصلاح: الكاردكس يَستعمل inventoryService.signedMoveQty (يستعيد إشارة ADJUST من النص).
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { setStock } from "../inventoryService";
import { getItemLedger } from "../reportsInventoryAnalyticsService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  await truncateTables(["inventoryMovements", "branchStock", "productVariants", "products", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
});

describe("INV-001 — كاردكس يَستعيد إشارة ADJUST (لا رصيد منفوخ)", () => {
  it("تسوية هابطة تُحسب سالبة ⇒ الرصيد المتحرّك والختامي = المخزون الحقيقي لا المنفوخ", async () => {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 100, createdBy: 1 })); // 0→100 (+100)
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 60, createdBy: 1 })); // 100→60 (−40)

    const led = await getItemLedger({ variantId: 1, branchId: 1 });
    expect(led.rows).toHaveLength(2);
    expect(led.rows[0].signedQty).toBe(100);
    expect(led.rows[0].balance).toBe(100);
    expect(led.rows[1].signedQty).toBe(-40); // كان +40 (الخلل) ⇒ رصيد 140
    expect(led.rows[1].balance).toBe(60);
    expect(led.closingBalance).toBe(60); // = المخزون الفعلي، لا 140
  });

  it("الرصيد الافتتاحي (قبل النافذة) يَجمع ADJUST مُوقَّعاً لا SUM(|الكمية|)", async () => {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 100, createdBy: 1 })); // +100
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 60, createdBy: 1 })); // −40
    // نافذة تبدأ بتاريخ بعيد ⇒ الحركتان قبلها ⇒ الافتتاحي = 60 (لا 140 لو جُمعت المطلقات).
    const led = await getItemLedger({ variantId: 1, branchId: 1, from: "2999-01-01" });
    expect(led.openingBalance).toBe(60);
    expect(led.rows).toHaveLength(0);
    expect(led.closingBalance).toBe(60);
  });

  it("ثغرة المطابقة الأولى (تحقيق عدائي ٢٠/٦): ملاحظة حرّة فيها «فرق ٢٠٠» لا تُفسد العلامة الحقيقية", async () => {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 100, createdBy: 1 })); // +100
    // ملاحظة مستخدم خبيثة/طبيعية تحوي «فرق 200» قبل علامة setStock الحقيقية «(فرق -40)» في النهاية.
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 60, notes: "تصحيح فرق 200 قطعة ناقصة", createdBy: 1 })); // −40

    const led = await getItemLedger({ variantId: 1, branchId: 1 });
    expect(led.rows).toHaveLength(2);
    expect(led.rows[1].signedQty).toBe(-40); // ليس +200 (المطابقة مُرتكَزة على العلامة في النهاية)
    expect(led.closingBalance).toBe(60);
  });
});
