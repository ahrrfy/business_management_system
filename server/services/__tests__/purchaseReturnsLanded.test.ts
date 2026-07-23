// landed-cost على مرتجع الشراء (متابعة Codex على #311، تصحيح خطأ #318 — قرار المالك ٢٢/٧/٢٦):
// الشحن/الكمرك (landed) رُسمِل في تكلفة المخزون (WAVG) وأُضيف إلى ذمّة المورّد عند الاستلام (#311).
// قرار المالك: الشحن الوارد **غير مسترد** عند الإرجاع ⇒ (١) يُقيَّد **خسارةً** في الأرباح والخسائر
// (قيد ADJUST بمفتاح PURCHRET_LANDED)، و(٢) يبقى التزامه في ذمّة المورّد (قيد RETURN يَخصم قيمة
// البضاعة وحدها من AP) ⇒ الرصيد لا يُصفَّر بل يبقى = حصّة الشحن، وreconcileSupplierBalances يبقى خالياً.
//
// حارس red-green: بلا الإصلاح كان #318 يَعكس الشحن من AP فوق خصم RETURN (خصمٌ مزدوج) ⇒ الرصيد يعود
// صفراً خطأً + انحراف مطابقة دائم. تُثبّت الاختبارات الآن: الرصيد = الشحن + reconcileSupplierBalances خالٍ.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createPurchaseReturn } from "../purchaseReturnsService";
import { reconcileSupplierBalances } from "../reconcileService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices",
  "productUnits", "productVariants", "products", "auditLogs", "suppliers", "branches", "users",
];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
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

async function supplierBalance(): Promise<string> {
  const r = (await db().select({ b: s.suppliers.currentBalance }).from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
  return String(r?.b);
}
async function entries() {
  return db().select().from(s.accountingEntries).orderBy(s.accountingEntries.id);
}
async function landedLossEntries() {
  return (await entries()).filter(
    (e) => e.entryType === "ADJUST" && String(e.dedupeKey ?? "").startsWith("PURCHRET_LANDED:"),
  );
}

/** أمر شراء مُحمَّل: v1 10×100=1,000 + v2 5×600=3,000 (subtotal 4,000)، شحن 300 + كمرك 100 = 400.
 *  توزيع #311 بالقيمة: v1 حصّة 100 (10/وحدة ⇒ تكلفة 110)، v2 حصّة 300 (60/وحدة ⇒ تكلفة 660).
 *  عند الاستلام الكامل: AP = 4,400 (بضاعة 4,000 + شحن/كمرك 400). */
async function receiveLandedPO() {
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
  const items = await db().select().from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)).orderBy(s.purchaseOrderItems.id);
  await receivePurchase(
    { purchaseOrderId: po.purchaseOrderId, lines: items.map((it) => ({ purchaseOrderItemId: Number(it.id), receivedBaseQuantity: it.baseQuantity })) },
    actor,
  );
  return po.purchaseOrderId;
}

describe("landed-cost على مرتجع الشراء — الشحن غير مسترد ⇒ خسارة + إبقاء التزامه في ذمّة المورّد", () => {
  it("إرجاع كامل مرجعيّ (CREDIT) ⇒ رصيد المورّد = الشحن (400) + قيد خسارة الشحن = 400 (الثوابت ١+٢+٣)", async () => {
    const poId = await receiveLandedPO();
    expect(await supplierBalance()).toBe("4400.00"); // 4,000 بضاعة + 400 شحن/كمرك

    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: poId, settlement: "CREDIT",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }, // سعر البضاعة
          { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },
        ],
      },
      actor,
    );

    // (١) الرصيد = حصّة الشحن (400) تبقى ديناً — خصمُ RETURN غطّى البضاعة (4,000) فقط، لا يُصفَّر بالشحن.
    expect(await supplierBalance()).toBe("400.00");
    // (١-ب) لا انحراف مطابقة (إصلاح #318): المُتوقَّع من الدفتر = الرصيد المخزَّن (خصمُ RETURN وحده).
    expect(await reconcileSupplierBalances()).toEqual([]);

    // (٢) قيد خسارة ADJUST بمفتاح PURCHRET_LANDED، cost=400، بلا supplierId (لا يلوّث كشف المورّد).
    const adj = await landedLossEntries();
    expect(adj).toHaveLength(1);
    expect(adj[0].cost).toBe("400.00");
    expect(adj[0].amount).toBe("400.00");
    expect(adj[0].supplierId).toBeNull();
    expect(adj[0].purchaseOrderId).toBe(poId);

    // (٣) قائمة الدخل (نفس محرّك إقفال السنة): سطر خسائر الشحن = 400 يَخفض صافي الربح.
    const { plSnapshot } = await import("../reportsFinancialService");
    const pl = await plSnapshot("2020-01-01", "2099-12-31", 1);
    const line = pl.expenseLines.find((l) => l.key === "PURCH_RETURN_LANDED");
    expect(line?.amount).toBe("400.00");
    expect(pl.netProfit).toBe("-400.00"); // لا بيع ⇒ الربح الإجماليّ 0، والخسارة −400
  });

  it("إرجاع جزئيّ ⇒ خسارة شحن متناسبة (50) + عكس ذمّة متناسب", async () => {
    const poId = await receiveLandedPO();
    // أرجِع نصف v1 فقط (5 من 10) بسعر البضاعة 100.
    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: poId, settlement: "CREDIT",
        items: [{ variantId: 1, productUnitId: 1, quantity: "5", unitPrice: "100.00" }],
      },
      actor,
    );
    // البضاعة 500، وشحن v1 = 10/وحدة × 5 = 50 يبقى ديناً. AP = 4,400 − 500 = 3,900 (خصمُ RETURN وحده).
    expect(await supplierBalance()).toBe("3900.00");
    // لا انحراف مطابقة بعد المرتجع المُرسمَل الجزئيّ.
    expect(await reconcileSupplierBalances()).toEqual([]);
    const adj = await landedLossEntries();
    expect(adj).toHaveLength(1);
    expect(adj[0].cost).toBe("50.00");
  });

  it("سعر إرجاع أعلى من البضاعة (يعتمد المورّد جزءاً من الشحن) ⇒ لا عكس مزدوج (السقف)", async () => {
    const poId = await receiveLandedPO();
    // v1 بسعر إرجاع 110 (= التكلفة الدفترية الكاملة incl شحن) ⇒ المورّد يعتمد الشحن ⇒ خسارة 0 على v1.
    // v2 بسعر البضاعة 600 ⇒ خسارة شحنه 300.
    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: poId, settlement: "CREDIT",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "110.00" }, // = book cost
          { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },  // = goods price
        ],
      },
      actor,
    );
    // returnedTotal = 1,100 + 3,000 = 4,100. خسارة الشحن = 0 (v1) + 300 (v2) = 300 (السقف يمنع ازدواج v1).
    // AP = 4,400 − 4,100 = 300 (حصّة شحن v2 غير المُعتمَدة تبقى ديناً — خصمُ RETURN وحده يُخفض AP).
    expect(await supplierBalance()).toBe("300.00");
    const adj = await landedLossEntries();
    expect(adj).toHaveLength(1);
    expect(adj[0].cost).toBe("300.00");
  });

  it("أمر بلا شحن/كمرك ⇒ لا قيد خسارة (حارس انحدار) — الرصيد يعود صفراً بالبضاعة وحدها", async () => {
    const po = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }] },
      actor,
    );
    const it0 = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await receivePurchase({ purchaseOrderId: po.purchaseOrderId, lines: [{ purchaseOrderItemId: Number(it0.id), receivedBaseQuantity: 10 }] }, actor);
    expect(await supplierBalance()).toBe("1000.00");

    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: po.purchaseOrderId, settlement: "CREDIT",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
      },
      actor,
    );
    expect(await supplierBalance()).toBe("0.00");
    expect(await landedLossEntries()).toHaveLength(0);
  });

  it("مرتجع حرّ (بلا أمر مرجعيّ) ⇒ لا منطق شحن (الشحن مفهومُ أمرِ شراء)", async () => {
    // استلم أمراً مُحمَّلاً لبناء رصيد/تكلفة، ثم أرجِع بلا purchaseOrderRefId.
    await receiveLandedPO();
    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, settlement: "CREDIT",
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "100.00" }],
      },
      actor,
    );
    expect(await landedLossEntries()).toHaveLength(0);
  });

  it("إرجاع كامل نقديّ (CASH) ⇒ خسارة الشحن = 400 تُقيَّد في P&L + AP محايد + الميزانية تتّزن (إصلاح #321)", async () => {
    // ⚠️ حارس #321: قبل الإصلاح كانت الكتلة تتخطّى المسار النقديّ (settlementKind !== "CASH") ⇒ المخزون
    // يخرج بالقيمة الدفترية (شحن مُرسمَل) لكن لا قيد خسارة ⇒ الأصول تنقص بلا مقابلٍ في الدخل (قائمةُ دخلٍ ≠ ميزانية).
    const poId = await receiveLandedPO();
    expect(await supplierBalance()).toBe("4400.00"); // 4,000 بضاعة + 400 شحن/كمرك

    await createPurchaseReturn(
      {
        supplierId: 1, branchId: 1, purchaseOrderRefId: poId, settlement: "CASH", paymentMethod: "CASH",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }, // سعر البضاعة
          { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" },
        ],
      },
      actor,
    );

    // (١) المسار النقديّ محايدٌ على AP: خصمُ RETURN (−4,000) يُلغيه عكسُ استلام النقد (+4,000) ⇒ الرصيد ثابتٌ 4,400.
    expect(await supplierBalance()).toBe("4400.00");
    // (١-ب) لا انحراف مطابقة: خسارة الشحن بلا supplierId فلا تلوّث رصيد المورّد؛ المخزَّن = المُحتسَب من الدفتر.
    expect(await reconcileSupplierBalances()).toEqual([]);

    // (٢) المورد ردّ النقد بقيمة البضاعة (receipt IN = 4,000) — لا يشمل الشحن غير المسترد.
    const rcs = await db().select().from(s.receipts);
    expect(rcs).toHaveLength(1);
    expect(rcs[0].direction).toBe("IN");
    expect(rcs[0].amount).toBe("4000.00");

    // (٣) الإصلاح الجوهريّ: قيد خسارة الشحن ADJUST/PURCHRET_LANDED يُقيَّد للنقديّ أيضاً (كان مفقوداً — #321).
    const adj = await landedLossEntries();
    expect(adj).toHaveLength(1);
    expect(adj[0].cost).toBe("400.00");
    expect(adj[0].amount).toBe("400.00");
    expect(adj[0].supplierId).toBeNull();
    expect(adj[0].purchaseOrderId).toBe(poId);

    // (٤) قائمة الدخل تتّسق مع الميزانية: الأصول نقصت بحصّة الشحن (400)، وصافي الربح يعكس الخسارة نفسها.
    // (الأصول: مخزونٌ خرج بـ4,400 مقابل نقدٍ دخل 4,000 ⇒ صافي −400 = الخسارة المُقيَّدة ⇒ اتّزان.)
    const { plSnapshot } = await import("../reportsFinancialService");
    const pl = await plSnapshot("2020-01-01", "2099-12-31", 1);
    const line = pl.expenseLines.find((l) => l.key === "PURCH_RETURN_LANDED");
    expect(line?.amount).toBe("400.00");
    expect(pl.netProfit).toBe("-400.00"); // لا بيع ⇒ الربح الإجماليّ 0، والخسارة −400
  });
});
