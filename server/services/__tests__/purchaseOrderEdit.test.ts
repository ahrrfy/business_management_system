// تعديل أمر الشراء قبل الاستلام + اختياريّة إثبات الشحن/الكمرك (قرار المالك ١٧/٨/٢٦).
//
// شقّان تحرسهما هذه الحزمة:
//
// (أ) **التعديل** — `updatePurchaseOrder` يستبدل بنود الأمر ويُعيد اشتقاق إجمالياته بنفس حساب
//     الإنشاء (`computePurchaseDocument` مشترك). المنطقة الآمنة للتعديل هي «قبل أيّ أثر»:
//     لا سطرَ مستلَماً، ولا دفعةَ مسجَّلة، والحالة غير نهائية — وكلّ خرقٍ لها يُرفَض صراحةً بدل
//     أن يُصحّح مخزوناً أو ذمّةً مُرحَّلَين من تحت القيود.
//
// (ب) **اختياريّة إثبات الشحن** — كان الاستلام يرفض أيّ أمرٍ عليه شحن/كمرك ما لم يحمل الطلبُ
//     اسمَ ناقلٍ ومرجعَ مستند، بينما لا حقلَ لهما في شاشة الاستلام أصلاً ⇒ ميزةٌ مقفلة كلّياً.
//     صارا اختياريَّين، والخادم يُكمل الناقص ببديلٍ **صريح الجهالة** فيبقى المصروف مثبتاً
//     ومنسوباً وقابلاً للتصحيح — لا مبلغاً يضيع بصمت.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase, updatePurchaseOrder } from "../purchaseService";

const actor = { userId: 1, branchId: 1, role: "admin" as const };
/** مدير فرعٍ آخر — يحرس عزل الفرع على التعديل (لا عبور بين الفروع). */
const otherBranchManager = { userId: 3, branchId: 2, role: "manager" as const };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "idempotencyKeys",
    "accrualCorrectionRequests",
    "accrualObligationEvents",
    "accrualObligations",
    "accountingEntries",
    "expenses",
    "receipts",
    "inventoryMovements",
    "purchaseOrderItems",
    "purchaseOrders",
    "branchStock",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "suppliers",
    "branches",
    "users",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "recv-2", name: "أمين المخزن", role: "warehouse", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "mgr-3", name: "مدير فرع المبيعات", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.suppliers).values([
    { id: 1, name: "مورد أوّل", currentBalance: "0" },
    { id: 2, name: "مورد ثانٍ", currentBalance: "0" },
    { id: 3, name: "مودِع أمانة", currentBalance: "0", supplierKind: "CONSIGNOR" },
    { id: 4, name: "شركة النقل الأهلية", currentBalance: "0" },
  ]);
  // تمويل الخزينة — تسويةُ الشحن تبقى معلّقة، لكن نُبقي البيئة مطابقة لبقيّة حزم الشراء.
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
  });
  await d.insert(s.products).values([
    { id: 1, name: "ورق" },
    { id: 2, name: "حبر" },
    { id: 3, name: "بكج مكتبيّ", isBundle: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "P-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "P-2", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "P-3", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 1, unitName: "درزن", conversionFactor: "12" },
    { id: 4, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

async function orderRow(poId: number) {
  return (await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, poId)))[0];
}
async function itemsOf(poId: number) {
  return db()
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, poId))
    .orderBy(s.purchaseOrderItems.id);
}

/** أمرٌ ديناريّ بسيط: ١٠×١٠٠ = ١٬٠٠٠ بلا ضريبة ولا شحن. */
async function simpleOrder(status: "DRAFT" | "CONFIRMED" = "CONFIRMED") {
  return createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      status,
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    },
    actor,
  );
}

describe("تعديل أمر الشراء قبل الاستلام", () => {
  it("يستبدل البنود ويُعيد اشتقاق الإجماليات بنفس حساب الإنشاء", async () => {
    const po = await simpleOrder();
    const before = await orderRow(po.purchaseOrderId);
    expect(before.total).toBe("1000.00");

    const res = await updatePurchaseOrder(
      {
        purchaseOrderId: po.purchaseOrderId,
        supplierId: 2, // تبديل المورّد جزءٌ من التعديل
        taxRatePercent: "0",
        notes: "عُدّل قبل الاستلام",
        items: [
          { variantId: 1, productUnitId: 3, quantity: "2", unitPrice: "1200.00" }, // درزن ⇒ 2,400
          { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" }, // 3,000
        ],
      },
      actor,
    );

    expect(res.total).toBe("5400.00");
    const after = await orderRow(po.purchaseOrderId);
    expect(after.subtotal).toBe("5400.00");
    expect(after.total).toBe("5400.00");
    expect(Number(after.supplierId)).toBe(2);
    expect(after.notes).toBe("عُدّل قبل الاستلام");
    // رقم الأمر وحالته لا يتغيّران بالتعديل — لكلٍّ إجراؤه المستقلّ.
    expect(after.poNumber).toBe(before.poNumber);
    expect(after.status).toBe(before.status);

    const items = await itemsOf(po.purchaseOrderId);
    expect(items).toHaveLength(2);
    // الدرزن × ١٢ = ٢٤ بالوحدة الأساس — التحويل يمرّ بنفس convertToBaseQuantity.
    expect(items[0].baseQuantity).toBe(24);
    expect(items[0].total).toBe("2400.00");
    expect(items[1].total).toBe("3000.00");
  });

  it("يُعيد اشتقاق فاتورة الدولار وسعر التثبيت من البنود", async () => {
    const po = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        agreedCurrency: "USD",
        agreedRate: "1500.0000",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "2.00" }],
      },
      actor,
    );
    expect((await orderRow(po.purchaseOrderId)).usdTotal).toBe("20.00");

    await updatePurchaseOrder(
      {
        purchaseOrderId: po.purchaseOrderId,
        supplierId: 1,
        taxRatePercent: "0",
        agreedCurrency: "USD",
        agreedRate: "1500.0000",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "3.00" }],
      },
      actor,
    );

    const after = await orderRow(po.purchaseOrderId);
    expect(after.usdTotal).toBe("30.00");
    expect(after.total).toBe("45000.00"); // 3 × 1500 × 10
    expect(String(after.agreedRate)).toBe("1500.0000");
  });

  it("يُصفّر الشحن/الكمرك حين يُحذفان من التعديل", async () => {
    const po = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
        shippingCost: "300.00",
        customsCost: "100.00",
      },
      actor,
    );
    expect((await orderRow(po.purchaseOrderId)).shippingCost).toBe("300.00");

    await updatePurchaseOrder(
      {
        purchaseOrderId: po.purchaseOrderId,
        supplierId: 1,
        taxRatePercent: "0",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
      },
      actor,
    );

    const after = await orderRow(po.purchaseOrderId);
    expect(after.shippingCost).toBe("0.00");
    expect(after.customsCost).toBe("0.00");
    // الشحن كان خارج الإجمالي أصلاً ⇒ حذفُه لا يُحرّك الذمّة.
    expect(after.total).toBe("1000.00");
  });

  it("يرفض التعديل بعد استلام أيّ كمية (ولو جزئية)", async () => {
    const po = await simpleOrder();
    const items = await itemsOf(po.purchaseOrderId);
    // مُستلِمٌ غير المُنشئ (فصل المهام) — الأدمن مُستثنى لكنّنا نتبع المسار الواقعيّ.
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: 4 }],
      },
      { userId: 2, branchId: 1, role: "warehouse" },
    );

    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: po.purchaseOrderId,
          supplierId: 1,
          taxRatePercent: "0",
          items: [{ variantId: 1, productUnitId: 1, quantity: "99", unitPrice: "100.00" }],
        },
        actor,
      ),
    ).rejects.toThrow(/استُلمت بضاعة/);

    // ولا سطرَ تغيّر: الرفض قبل أيّ كتابة.
    const after = await itemsOf(po.purchaseOrderId);
    expect(after[0].quantity).toBe("10.000");
  });

  it("يرفض تعديل أمرٍ ملغى", async () => {
    const po = await simpleOrder();
    await db()
      .update(s.purchaseOrders)
      .set({ status: "CANCELLED" })
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));

    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: po.purchaseOrderId,
          supplierId: 1,
          taxRatePercent: "0",
          items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "100.00" }],
        },
        actor,
      ),
    ).rejects.toThrow(/مستلَم أو ملغى/);
  });

  it("يرفض التعديل حين يحمل الأمر دفعةً مسجَّلة", async () => {
    const po = await simpleOrder();
    await db()
      .update(s.purchaseOrders)
      .set({ paidAmount: "250.00" })
      .where(eq(s.purchaseOrders.id, po.purchaseOrderId));

    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: po.purchaseOrderId,
          supplierId: 1,
          taxRatePercent: "0",
          items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "100.00" }],
        },
        actor,
      ),
    ).rejects.toThrow(/دفعة مسجَّلة/);
  });

  it("يحرس عزل الفرع: مدير فرعٍ آخر لا يعدّل أمر فرعٍ ليس فرعه", async () => {
    const po = await simpleOrder();
    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: po.purchaseOrderId,
          supplierId: 1,
          taxRatePercent: "0",
          items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "100.00" }],
        },
        otherBranchManager,
      ),
    ).rejects.toThrow(/فرع آخر/);
  });

  it("يرفض إدخال بكج أو تحويل المورّد إلى مودِع أمانة عبر التعديل", async () => {
    const po = await simpleOrder();
    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: po.purchaseOrderId,
          supplierId: 1,
          taxRatePercent: "0",
          items: [{ variantId: 3, productUnitId: 4, quantity: "1", unitPrice: "5000.00" }],
        },
        actor,
      ),
    ).rejects.toThrow(/بكج/);

    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: po.purchaseOrderId,
          supplierId: 3, // مودِع أمانة
          taxRatePercent: "0",
          items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "100.00" }],
        },
        actor,
      ),
    ).rejects.toThrow(/مودِع أمانة/);
  });

  it("يرفض أمراً بلا أصناف ونسبةَ ضريبةٍ خارج المدى (مرآة حرّاس الإنشاء)", async () => {
    const po = await simpleOrder();
    await expect(
      updatePurchaseOrder(
        { purchaseOrderId: po.purchaseOrderId, supplierId: 1, taxRatePercent: "0", items: [] },
        actor,
      ),
    ).rejects.toThrow(/بلا أصناف/);

    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: po.purchaseOrderId,
          supplierId: 1,
          taxRatePercent: "150",
          items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "100.00" }],
        },
        actor,
      ),
    ).rejects.toThrow(/نسبة الضريبة/);
  });
});

describe("إثبات الشحن/الكمرك اختياريّ — لا يحجب الاستلام", () => {
  async function orderWithShipping() {
    return createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
        shippingCost: "300.00",
        customsCost: "100.00",
      },
      actor,
    );
  }

  it("يُستلَم بلا اسم ناقلٍ ولا مستند، ويُسجَّل المصروف ببديلٍ صريح الجهالة", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);

    // بلا shippingBeneficiaryName ولا shippingEvidenceReference — وهذا كان يُرفَض حتماً قبل الإصلاح.
    const res = await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: items[0].baseQuantity }],
      },
      { userId: 2, branchId: 1, role: "warehouse" },
    );
    expect(res.fullyReceived).toBe(true);
    expect(res.shippingPaymentRequestReceiptId).not.toBeNull();

    // المصروف موجودٌ فعلاً (لا مالٌ يضيع بصمت) ومنسوبٌ لطرفٍ يُقرأ في التقارير.
    const [expense] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.category, "TRANSPORT"));
    expect(expense).toBeTruthy();
    expect(expense.amount).toBe("400.00");
    expect(expense.payee).toBe("ناقل غير محدَّد");

    // الالتزام يحمل نفس النسبة، ومرجعُ مستنده هو أمر الشراء نفسه — مستندٌ داخليّ حقيقيّ.
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, po.purchaseOrderId));
    expect(obligation.beneficiaryType).toBe("OTHER");
    expect(obligation.beneficiaryName).toBe("ناقل غير محدَّد");
    expect(obligation.evidenceReference).toBe(`أمر الشراء ${po.poNumber}`);
  });

  it("يُعامل نائبات «لا شيء» كفراغٍ بدل رفضها بخطأ", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);

    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: items[0].baseQuantity }],
        shippingBeneficiaryName: "لا يوجد",
        shippingEvidenceReference: "-",
      },
      { userId: 2, branchId: 1, role: "warehouse" },
    );

    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, po.purchaseOrderId));
    expect(obligation.beneficiaryName).toBe("ناقل غير محدَّد");
    expect(obligation.evidenceReference).toBe(`أمر الشراء ${po.poNumber}`);
  });

  it("يحفظ الناقل والمستند حين يُدخَلان — الاختياريّة لا تُلغي التسجيل", async () => {
    const po = await orderWithShipping();
    const items = await itemsOf(po.purchaseOrderId);

    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(items[0].id), receivedBaseQuantity: items[0].baseQuantity }],
        shippingBeneficiarySupplierId: 4,
        shippingEvidenceReference: "INV-CARRIER-8891",
      },
      { userId: 2, branchId: 1, role: "warehouse" },
    );

    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, po.purchaseOrderId));
    expect(obligation.beneficiaryType).toBe("SUPPLIER");
    expect(Number(obligation.beneficiarySupplierId)).toBe(4);
    expect(obligation.beneficiaryName).toBe("شركة النقل الأهلية");
    expect(obligation.evidenceReference).toBe("INV-CARRIER-8891");
  });
});
