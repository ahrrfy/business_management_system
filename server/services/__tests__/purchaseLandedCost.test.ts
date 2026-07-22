// landed-cost (تكلفة الشحن/الكمرك): تُوزَّع على بنود أمر الشراء **بنسبة القيمة** وتُرسمَل في تكلفة
// المخزون (WAVG) عند الاستلام ⇒ تظهر في COGS عند البيع، وتُضاف إلى ذمّة المورّد (AP). لا تُسجَّل
// مصروفَ P&L (منعُ ازدواج مع COGS). هذه الاختبارات تُثبِت الثوابت الأربعة:
//   (١) WAVG لكلّ بند يشمل حصّته المُوزَّعة بالقيمة (لا بالكمية).
//   (٢) AP = الإجماليّ الشامل (البضاعة + الضريبة + الشحن + الكمرك).
//   (٣) لا قيد مصروفٍ منفصل — قيد PURCHASE واحدٌ فقط (cost = البضاعة + الشحن/الكمرك المُرسمَلة).
//   (٤) الاستلام الجزئيّ يُرسمِل حصّته بدقّة (Σ عبر الاستلامات = الحصّة بالضبط، لا انجراف).
// (بلا الإصلاح: total=البضاعة فقط، والتكلفة/AP بلا الشحن ⇒ كلّ التوكيدات المُرسمَلة تفشل.)
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices", "productUnits", "productVariants", "products", "suppliers", "branches", "users"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
  await d.insert(s.products).values([{ id: 1, name: "ورق" }, { id: 2, name: "حبر" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "P-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "P-2", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
}
beforeEach(async () => { await reset(); await seed(); });

async function costOf(variantId: number): Promise<string> {
  const r = (await db().select({ c: s.productVariants.costPrice }).from(s.productVariants).where(eq(s.productVariants.id, variantId)))[0];
  return String(r?.c);
}
async function supplierBalance(): Promise<string> {
  const r = (await db().select({ b: s.suppliers.currentBalance }).from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
  return String(r?.b);
}
async function itemsOf(poId: number) {
  return db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, poId)).orderBy(s.purchaseOrderItems.id);
}
async function entries() {
  return db().select().from(s.accountingEntries).orderBy(s.accountingEntries.id);
}

describe("landed-cost — رسملة الشحن/الكمرك (توزيع بالقيمة + AP + بلا ازدواج)", () => {
  it("createPurchaseOrder: total = البضاعة + الضريبة + الشحن + الكمرك، والحقلان يُخزَّنان", async () => {
    const po = await createPurchaseOrder(
      {
        supplierId: 1, branchId: 1, taxRatePercent: "0",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }, // 1,000
          { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },  // 3,000
        ],
        shippingCost: "300", customsCost: "100",
      },
      actor,
    );
    const row = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, po.purchaseOrderId)))[0];
    expect(row.subtotal).toBe("4000.00");
    expect(row.shippingCost).toBe("300.00");
    expect(row.customsCost).toBe("100.00");
    expect(row.total).toBe("4400.00"); // 4000 + 0 ضريبة + 400 شحن/كمرك
  });

  it("استلام كامل: WAVG يشمل الحصّة المُوزَّعة **بالقيمة** + AP شامل + قيد PURCHASE واحد بلا مصروف منفصل", async () => {
    // بندان: قيمة 1,000 (10×100) وقيمة 3,000 (5×600). المجموع 4,000. شحن 300 + كمرك 100 = 400.
    // التوزيع بالقيمة: الحصّة_أ = 400×1000/4000 = 100 ⇒ لكلّ وحدة 100/10 = 10 ⇒ التكلفة 110.
    //                  الحصّة_ب = 400×3000/4000 = 300 ⇒ لكلّ وحدة 300/5  = 60 ⇒ التكلفة 660.
    // (لو كان التوزيع بالكمية لكانت 400/15=26.67 للوحدة ⇒ 126.67 و626.67 — مختلفة تماماً.)
    const po = await createPurchaseOrder(
      {
        supplierId: 1, branchId: 1, taxRatePercent: "0",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
          { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },
        ],
        shippingCost: "300", customsCost: "100",
      },
      actor,
    );
    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      { purchaseOrderId: po.purchaseOrderId, lines: items.map((it) => ({ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: it.baseQuantity })) },
      actor,
    );

    // (١) WAVG لكلّ بند يشمل حصّته المُوزَّعة بالقيمة (لا بالكمية).
    expect(await costOf(1)).toBe("110.00");
    expect(await costOf(2)).toBe("660.00");

    // (٢) AP = الإجماليّ الشامل.
    expect(await supplierBalance()).toBe("4400.00");

    // (٣) قيد PURCHASE واحد فقط — لا مصروف منفصل. cost = البضاعة + الشحن/الكمرك المُرسمَلة.
    const es = await entries();
    expect(es.length).toBe(1);
    expect(es[0].entryType).toBe("PURCHASE");
    expect(es[0].cost).toBe("4400.00");   // 4000 بضاعة + 400 شحن/كمرك
    expect(es[0].amount).toBe("4400.00"); // نفس أثر AP
    expect(es[0].taxAmount).toBe("0.00");
    expect(es[0].revenue).toBe("0.00");
    expect(es[0].profit).toBe("0.00");
  });

  it("بلا شحن/كمرك ⇒ سلوكٌ غير متغيّر (total = البضاعة، التكلفة/AP بلا رسملة) — حارس انحدار", async () => {
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }] },
      actor,
    );
    const row = (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, po.purchaseOrderId)))[0];
    expect(row.shippingCost).toBe("0.00");
    expect(row.customsCost).toBe("0.00");
    expect(row.total).toBe("1000.00");
    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: 10 }] }, actor);
    expect(await costOf(1)).toBe("100.00");
    expect(await supplierBalance()).toBe("1000.00");
  });

  it("استلام جزئيّ: الحصّة تُرسمَل تدريجياً وΣ = الحصّة بالضبط (لا انجراف تقريب)", async () => {
    // بند واحد قيمته 1,000 (10×100)، كمرك 33 (رقمٌ يُنتج كسوراً). الحصّة = 33 (بندٌ وحيد).
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }], customsCost: "33" },
      actor,
    );
    const items = await itemsOf(po.purchaseOrderId);
    const itemId = Number(items[0].id);

    // استلام ٣ من ١٠: cumLanded(3) = round2(33×3/10) = 9.90 ⇒ AP += 300 + 9.90 = 309.90.
    // WAVG: 100 + 33/10 = 103.30 (بلا مخزون قائم).
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: itemId, receivedBaseQuantity: 3 }] }, actor);
    expect(await costOf(1)).toBe("103.30");
    expect(await supplierBalance()).toBe("309.90");

    // استلام ٧ المتبقّية (يُكمِل): الحصّة المتبقّية = 33 − 9.90 = 23.10 ⇒ AP += 700 + 23.10 = 723.10.
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: itemId, receivedBaseQuantity: 7 }] }, actor);
    expect(await costOf(1)).toBe("103.30"); // المتوسّط المرجّح ثابت (تكلفة موحّدة)
    expect(await supplierBalance()).toBe("1033.00"); // 1000 بضاعة + 33 كمرك — بالضبط

    // قيدا PURCHASE (واحدٌ لكلّ استلام) — مجموع amount = 1,033.00 بالضبط، لا مصروف منفصل.
    const es = await entries();
    expect(es.length).toBe(2);
    expect(es.every((e) => e.entryType === "PURCHASE")).toBe(true);
    expect(es[0].amount).toBe("309.90");
    expect(es[1].amount).toBe("723.10");
  });

  it("حارس: شحن/كمرك على أمر بقيمة بضاعة صفر ⇒ BAD_REQUEST (لا وعاء للتوزيع)", async () => {
    await expect(
      createPurchaseOrder(
        { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "0" }], shippingCost: "100" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await db().select().from(s.purchaseOrders)).length).toBe(0);
  });

  it("حارس: شحن سالب ⇒ BAD_REQUEST", async () => {
    await expect(
      createPurchaseOrder(
        { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100" }], shippingCost: "-5" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
