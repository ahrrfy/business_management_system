import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createPurchaseOrder,
  receivePurchase,
  updatePurchaseOrder,
} from "../purchaseService";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";

/**
 * بلاغ المالك (١٧/٨/٢٦): «سعر الشراء لا يمكن أن يكون 1,450.99، وبالدولار لا يقبل 3.4566».
 *
 * سعرُ الوحدة يُدخَل **بعملة الأمر**، ودقّتُه صفةُ تلك العملة (`shared/moneyPrecision`):
 *   • الدينار منزلتان — عمود `purchaseOrderItems.unitPrice decimal(15,2)`.
 *   • الدولار أربع  — عمود `purchaseOrderItems.usdUnitPrice decimal(15,4)`.
 *
 * وكان النظام يقصّ الدولار إلى منزلتين على حدّ الـAPI فيرمي دقّةً **صمّمت قاعدتُه لحفظها**:
 * على ٥٠٠٠ وحدة، الفرق بين 3.4566 و3.46 هو $17 تختفي من ذمّة المورّد ومن تكلفة الصنف (WAVG)
 * فتبقى أرباح كلّ بيعةٍ لاحقة مغلوطة. هذه الحزمة تُثبّت الحفظ بلا فقد، والرفض الصريح عند تجاوز
 * دقّة العملة (لا تقريباً صامتاً)، وترجمةَ الدينار من **إجمالي السطر بالدولار** لا من سعر
 * الوحدة بعد تقريبه.
 */

const actor = { userId: 1, branchId: 1, role: "manager" } as const;

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
    "purchaseOrderEvents",
    "purchaseOrderControlRequests",
    "purchaseOrderRequisitionAllocations",
    "purchaseOrderRevisionItems",
    "purchaseOrderRevisions",
    "accountingEntries",
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
  ])
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "price-precision",
      name: "منشئ",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "price-precision-recv",
      name: "مستلم",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد" });
  await d.insert(s.products).values([
    { id: 1, name: "قلم" },
    { id: 2, name: "دفتر" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "NOTE-1", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

const readOrder = async (purchaseOrderId: number) => ({
  po: (
    await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, purchaseOrderId))
  )[0],
  item: (
    await db()
      .select()
      .from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, purchaseOrderId))
  )[0],
});

async function approvePurchaseOrder(
  created: Awaited<ReturnType<typeof createPurchaseOrder>>,
) {
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "إرسال أمر اختبار دقة السعر للمراجعة",
      requestKey: `price-po-submit:${randomUUID()}`,
    },
    actor,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `price-po-approve:${randomUUID()}`,
      approve: true,
      reason: "راجعت دقة السعر والعملة واعتمدت الأمر",
    },
    { userId: 2, branchId: 1, role: "manager" },
    { legacyConfirmOnly: true },
  );
}

describe("دقّة سعر شراء الوحدة حسب عملة الأمر", () => {
  it("الدينار: 1450.99 تُحفَظ كما هي ويُشتقّ الإجمالي منها (نواة البلاغ)", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "1450.99",
          },
        ],
      },
      actor,
    );

    const { po, item } = await readOrder(created.purchaseOrderId);
    expect(item.unitPrice).toBe("1450.99");
    expect(item.total).toBe("14509.90");
    expect(po.subtotal).toBe("14509.90");
    expect(po.total).toBe("14509.90");
  });

  it("الدولار: 3.4566 تُحفَظ بأربع منازل، والدينار يُترجَم من إجمالي السطر الدولاريّ", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "USD",
        agreedRate: "1480",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5000",
            unitPrice: "3.4566",
          },
        ],
      },
      actor,
    );

    const { po, item } = await readOrder(created.purchaseOrderId);
    // (١) السعر الدولاريّ محفوظ بلا قصّ — كان يُخزَّن 3.4600.
    expect(item.usdUnitPrice).toBe("3.4566");
    // (٢) إجمالي السطر بالدولار = فاتورة المورد حرفياً: 3.4566 × 5000.
    expect(item.usdTotal).toBe("17283.00");
    expect(po.usdTotal).toBe("17283.00");
    // (٣) الدينار ترجمةُ **إجمالي السطر** لا ضربُ سعر وحدةٍ مقرَّب: 17283 × 1480.
    //     (الضرب بعد التقريب كان يُعطي 5115.77 × 5000 = 25,578,850 ⇒ فرقُ تقريبٍ يكبر بالكمية.)
    expect(item.total).toBe("25578840.00");
    expect(po.subtotal).toBe("25578840.00");
    expect(po.total).toBe("25578840.00");
    // (٤) سعر الوحدة الدينارّي يبقى ٢dp (عمودُه decimal(15,2)) — مرجعُ تكلفةِ الوحدة عند الاستلام.
    expect(item.unitPrice).toBe("5115.77");
    // (٥) القصّ القديم كان يُنقص ذمّة المورّد بـ$17 (≈ ٢٥٬١٦٠ د.ع) على هذا السطر وحده.
    expect(Number(po.total)).toBeLessThan(3.46 * 5000 * 1480);
  });

  it("يرفض صراحةً ما تجاوز دقّة العملة بدل تقريبه صامتاً", async () => {
    // الدينار: ثلاث منازل مرفوضة (العمود decimal(15,2)) — الرسالة تسمّي الصنف والحدّ.
    await expect(
      createPurchaseOrder(
        {
          supplierId: 1,
          branchId: 1,
          items: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "1",
              unitPrice: "1450.999",
            },
          ],
        },
        actor,
      ),
    ).rejects.toThrow(/منازل عشرية/);

    // الدولار: خمس منازل مرفوضة (العمود decimal(15,4)).
    await expect(
      createPurchaseOrder(
        {
          supplierId: 1,
          branchId: 1,
          agreedCurrency: "USD",
          agreedRate: "1480",
          items: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "1",
              unitPrice: "3.45666",
            },
          ],
        },
        actor,
      ),
    ).rejects.toThrow(/منازل عشرية/);
  });

  it("السعر الغائب لا يُنتج رسالة «منازل عشرية» مضلِّلة (يبقى صفراً كما كان)", async () => {
    // حارس الدقّة يفحص **قيمةً حاضرة فقط**: المستدعي المباشر (بذرة/استيراد/اختبار) قد يُغفل
    // الحقل، فتُعامَل صفراً منذ الأصل عبر `money()`. إقحامُها في فحص الدقّة كان يقول «يقبل
    // منزلتين» عن حقلٍ لم يُرسَل إطلاقاً — أمسكه CI على أمرٍ بحقلٍ خاطئ الاسم.
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "1" } as never],
      },
      actor,
    );
    const { po, item } = await readOrder(created.purchaseOrderId);
    expect(item.unitPrice).toBe("0.00");
    expect(po.total).toBe("0.00");
  });

  it("مطابقة فاتورة المورّد: القيمة المطابِقة تمرّ، والمخالِفة تُرَدّ برسالةٍ تحمل الرقمين والفرق", async () => {
    // مطابقة ⇒ الحفظ يمرّ، والأمر المحفوظ لا يخالف مستنده.
    const ok = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "1450.99",
          },
        ],
        supplierInvoiceTotal: "14509.90",
      },
      actor,
    );
    expect((await readOrder(ok.purchaseOrderId)).po.total).toBe("14509.90");

    // مخالفة ⇒ رفضٌ **تشخيصيّ**: الرقمان والفرق واتّجاهه (كانت الرسالة «لا يطابق مجموع البنود» عمياء).
    await expect(
      createPurchaseOrder(
        {
          supplierId: 1,
          branchId: 1,
          items: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "10",
              unitPrice: "1450.99",
            },
          ],
          supplierInvoiceTotal: "14000.00",
        },
        actor,
      ),
    ).rejects.toThrow(/14000\.00.*14509\.90.*509\.90/s);

    // فارغة ⇒ لا مطابقة (السلوك التاريخيّ محفوظ: الضابط اختياريّ لا شرطُ حفظ).
    const unset = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "1450.99",
          },
        ],
      },
      actor,
    );
    expect((await readOrder(unset.purchaseOrderId)).po.total).toBe("14509.90");
  });

  it("مطابقة الأمر الدولاريّ تكون بإجماليه **الدولاريّ** (مستند المورّد) لا الدينارّي", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "USD",
        agreedRate: "1480",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5000",
            unitPrice: "3.4566",
          },
        ],
        supplierInvoiceTotal: "17283.00",
      },
      actor,
    );
    const { po } = await readOrder(created.purchaseOrderId);
    // `usdTotal` صار **مُعلَناً مُطابَقاً** لا مشتقّاً وحسب.
    expect(po.usdTotal).toBe("17283.00");
    expect(po.total).toBe("25578840.00");

    // تمرير الإجماليّ الدينارّي مكان الدولاريّ خطأٌ يُمسَك بالرمز `$` في الرسالة.
    await expect(
      createPurchaseOrder(
        {
          supplierId: 1,
          branchId: 1,
          agreedCurrency: "USD",
          agreedRate: "1480",
          items: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "5000",
              unitPrice: "3.4566",
            },
          ],
          supplierInvoiceTotal: "25578840.00",
        },
        actor,
      ),
    ).rejects.toThrow(/\$/);
  });

  it("تعديلُ أمرٍ دولاريّ لا يقصّ أسعاره (كان كلُّ حفظٍ يُنقص قيمة الفاتورة)", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "USD",
        agreedRate: "1480",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5000",
            unitPrice: "3.4566",
          },
        ],
      },
      actor,
    );

    await updatePurchaseOrder(
      {
        purchaseOrderId: created.purchaseOrderId,
        expectedVersion: created.version,
        revisionReason: "تعديل ملاحظة لاختبار دقة الدولار",
        supplierId: 1,
        notes: "تعديل ملاحظة فقط",
        agreedCurrency: "USD",
        agreedRate: "1480",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5000",
            unitPrice: "3.4566",
          },
        ],
      },
      actor,
    );

    const { po, item } = await readOrder(created.purchaseOrderId);
    expect(item.usdUnitPrice).toBe("3.4566");
    expect(po.total).toBe("25578840.00");
  });
});

/**
 * خصم فاتورة المورّد (0204) — الفجوة التي كانت تجعل مطابقة فاتورةٍ فيها خصمٌ مستحيلة:
 * الخصم غيرُ ممثَّل في المخطّط إطلاقاً (لا سطريّ ولا فاتوريّ). النموذج: يُوزَّع بنسبة القيمة
 * فتُخزَّن أعمدةُ المال **صافيةً** ⇒ الذمّة (AP) وتكلفةُ المخزون (WAVG) ومرتجعُ الشراء تلتقطه
 * بلا تغييرٍ في أيٍّ من قرّائها، ويبقى سعرُ ما قبل الخصم لقطةً لورقة المورّد.
 */
describe("خصم فاتورة المورّد على أمر الشراء", () => {
  it("يُوزَّع بنسبة القيمة، ويُخزَّن صافياً مع لقطةِ السعر قبل الخصم", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        // بندان: 1000×10 = 10,000 و500×10 = 5,000 ⇒ المجموع 15,000، وخصمُ 1,500 = ١٠٪.
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "1000" },
          { variantId: 2, productUnitId: 2, quantity: "10", unitPrice: "500" },
        ],
        invoiceDiscount: "1500",
      },
      actor,
    );

    const { po } = await readOrder(created.purchaseOrderId);
    const items = await db()
      .select()
      .from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId))
      .orderBy(s.purchaseOrderItems.id);

    // (١) الأعمدة المالية صافية: 13,500 لا 15,000 ⇒ AP والتكلفة تلتقطان الخصم بلا تغييرٍ فيهما.
    expect(po.subtotal).toBe("13500.00");
    expect(po.total).toBe("13500.00");
    // (٢) التوزيع بنسبة القيمة: ١٠٪ من كلّ بند.
    expect(items[0].total).toBe("9000.00");
    expect(items[1].total).toBe("4500.00");
    expect(items[0].unitPrice).toBe("900.00");
    expect(items[1].unitPrice).toBe("450.00");
    // (٣) لقطةُ ورقة المورّد: السعر قبل الخصم محفوظٌ فلا يضيع سعرُ المورّد من التاريخ.
    expect(items[0].listUnitPrice).toBe("1000.00");
    expect(items[1].listUnitPrice).toBe("500.00");
    // (٤) الخصم مُفصَحٌ على الأمر (إفصاحٌ وإعادةُ تحميل — لا يدخل أيّ حساب).
    expect(po.invoiceDiscount).toBe("1500.00");
  });

  it("بلا خصم ⇒ صفر أثرٍ سلوكيّ: الأعمدة كما كانت و`listUnitPrice` فارغ", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "1450.99",
          },
        ],
      },
      actor,
    );
    const { po, item } = await readOrder(created.purchaseOrderId);
    expect(po.subtotal).toBe("14509.90");
    expect(po.invoiceDiscount).toBe("0.00");
    expect(item.listUnitPrice).toBeNull();
    expect(item.unitPrice).toBe("1450.99");
  });

  it("مجموعُ البنود يساوي الصافي بالضبط ولو لم يقبل الخصمُ القسمة (لا انجراف فلس)", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          { variantId: 1, productUnitId: 1, quantity: "3", unitPrice: "33.33" },
          { variantId: 2, productUnitId: 2, quantity: "3", unitPrice: "66.67" },
        ],
        invoiceDiscount: "0.01",
      },
      actor,
    );
    const { po } = await readOrder(created.purchaseOrderId);
    const items = await db()
      .select()
      .from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
    const sum = items.reduce((acc, r) => acc + Number(r.total), 0);
    expect(po.subtotal).toBe("299.99");
    expect(Number(sum.toFixed(2))).toBe(299.99);
    expect(po.invoiceDiscount).toBe("0.01");
  });

  it("خصمٌ يتجاوز قيمة البضاعة يُرفض بالرقمين (لا ذمّة سالبة ولا تكلفة سالبة)", async () => {
    await expect(
      createPurchaseOrder(
        {
          supplierId: 1,
          branchId: 1,
          items: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "1",
              unitPrice: "1000",
            },
          ],
          invoiceDiscount: "1500",
        },
        actor,
      ),
    ).rejects.toThrow(/1500\.00.*1000\.00/s);
  });

  it("الأمر الدولاريّ: الخصم بالدولار، والدينار ترجمتُه، والمطابقة على الصافي", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "USD",
        agreedRate: "1480",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5000",
            unitPrice: "3.4566",
          },
        ],
        invoiceDiscount: "283", // 17,283 − 283 = 17,000 $
        supplierInvoiceTotal: "17000.00", // قيمة الورقة بعد الخصم
      },
      actor,
    );
    const { po, item } = await readOrder(created.purchaseOrderId);
    expect(po.usdTotal).toBe("17000.00");
    expect(po.usdInvoiceDiscount).toBe("283.00");
    expect(item.usdTotal).toBe("17000.00");
    // السعر الصافي بأربع منازل، ولقطةُ ما قبل الخصم محفوظة.
    expect(item.usdListUnitPrice).toBe("3.4566");
    expect(item.usdUnitPrice).toBe("3.4000");
    // الدينار = ترجمةُ الصافي: 17,000 × 1480.
    expect(po.total).toBe("25160000.00");
    expect(po.invoiceDiscount).toBe("418840.00"); // (17283 − 17000) × 1480
  });

  it("إعادةُ الحفظ بالسعر قبل الخصم + الخصم نفسه ⇒ نفس النتيجة (لا خصمٌ مرّتين)", async () => {
    // هذا هو عقدُ محرّر التعديل: يُعيد تحميل `listUnitPrice` (ما قبل الخصم) مع الخصم في حقله،
    // فيُعاد التوزيع من الأصل. لو حمّل السعر الصافي لخُصم مرّتين وتآكلت الفاتورة كلّ حفظ.
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "1000" },
          { variantId: 2, productUnitId: 2, quantity: "10", unitPrice: "500" },
        ],
        invoiceDiscount: "1500",
      },
      actor,
    );
    const before = await readOrder(created.purchaseOrderId);

    await updatePurchaseOrder(
      {
        purchaseOrderId: created.purchaseOrderId,
        expectedVersion: Number(before.po.version),
        revisionReason: "إعادة حفظ أسعار ما قبل الخصم",
        supplierId: 1,
        notes: "إعادة حفظ",
        // نفس ما يُعيد المحرّر إرساله: أسعارُ ما قبل الخصم + الخصم كما هو.
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "1000" },
          { variantId: 2, productUnitId: 2, quantity: "10", unitPrice: "500" },
        ],
        invoiceDiscount: "1500",
      },
      actor,
    );

    const after = await readOrder(created.purchaseOrderId);
    expect(after.po.subtotal).toBe(before.po.subtotal);
    expect(after.po.total).toBe("13500.00");
    expect(after.po.invoiceDiscount).toBe("1500.00");
  });

  it("الثابت المحفوظ: Σ إجماليات البنود = المجموع الفرعيّ، والانحراف عن (سعر×كمّية) محدودٌ بفلوس", async () => {
    // التوزيع يضمن **الدقّة حيث يُقيَّد المال**: مجموع `total` = الصافي بالضبط (وهو ما تُرحّله AP
    // ويُطابق ورقة المورّد). في المقابل قد يفترق `unitPrice × qty` عن `total` بفلوسٍ معدودة على
    // بندٍ واحد (البند الماصّ) حين لا يقبل الخصمُ القسمةَ على الكمّية — وهو نفس نمط الامتصاص
    // المستعمَل في `allocateLineTax` وفي بقايا الاستلام. نُثبّت الحدّ صراحةً كي لا يتّسع صامتاً.
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "3",
            unitPrice: "333.33",
          },
          {
            variantId: 2,
            productUnitId: 2,
            quantity: "7",
            unitPrice: "111.11",
          },
        ],
        invoiceDiscount: "100",
      },
      actor,
    );
    const { po } = await readOrder(created.purchaseOrderId);
    const items = await db()
      .select()
      .from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));

    // (١) الثابت الصارم: Σ البنود = المجموع الفرعيّ = الإجماليّ قبل الخصم − الخصم.
    const sumTotals = items.reduce((acc, r) => acc + Number(r.total), 0);
    expect(Number(sumTotals.toFixed(2))).toBe(Number(po.subtotal));
    expect(Number(po.subtotal)).toBe(
      Number((999.99 + 777.77 - 100).toFixed(2)),
    );
    expect(po.invoiceDiscount).toBe("100.00");

    // (٢) الحدّ المُعلَن: انحراف (سعر × كمّية) عن إجمالي السطر ≤ ٥ فلوس على أيّ بند.
    for (const r of items) {
      const drift = Math.abs(
        Number(r.unitPrice) * Number(r.quantity) - Number(r.total),
      );
      expect(drift).toBeLessThanOrEqual(0.05);
    }
  });

  it("الاستلام يلتقط الخصم تلقائياً: الذمّة والتكلفة (WAVG) صافيتان بلا تغييرٍ في قرّائهما", async () => {
    // هذا هو **جوهر النموذج**: لأنّ الأعمدة مخزَّنة صافيةً، لم يُمَسّ `receive.ts` ولا
    // `purchaseReturnsService` — فيلزم إثباتُ أنّ الخصم يصل فعلاً إلى ذمّة المورّد وتكلفة الصنف
    // من طريق القرّاء القائمين، لا الاكتفاء بفحص أعمدة الأمر.
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "1000" },
        ],
        invoiceDiscount: "1000", // ١٠٪ ⇒ الصافي 9,000 وتكلفة القطعة 900
      },
      actor,
    );
    await approvePurchaseOrder(created);
    const { item } = await readOrder(created.purchaseOrderId);

    await receivePurchase(
      {
        purchaseOrderId: created.purchaseOrderId,
        lines: [
          { purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 10 },
        ],
      },
      { userId: 2, branchId: 1, role: "manager" },
    );

    const supplier = (
      await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1))
    )[0];
    const variant = (
      await db()
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0];
    // الذمّة = الصافي (9,000) لا الإجماليّ قبل الخصم (10,000).
    expect(supplier.currentBalance).toBe("9000.00");
    // تكلفة الوحدة الأساس = الصافي ÷ الكمّية (900) لا 1,000 ⇒ الخصم يَنقص COGS لكلّ بيعةٍ لاحقة.
    expect(variant.costPrice).toBe("900.00");
  });
});
