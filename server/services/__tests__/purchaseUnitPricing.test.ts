import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";

/**
 * PUR-UNIT-01 (٤/٩/٢٦ — تدقيق Codex) — سعرُ الشراء يُدخَل **بوحدة الصفّ** المختارة
 * (قطعة/درزن/كرتون)، ثمّ يقسمه `receive.ts` على معامل الوحدة ليحصل على `costPerBase` الداخل
 * في WAVG. لقطةُ Codex (cp47) أثبتت أنّ الشاشة تُقدّم درزناً (معامل ١٢) بسعرِ ١٥٠ (وهو تكلفة
 * القطعة) بدل ١٨٠٠ (١٥٠ × ١٢). حين تصل هذه الحمولة الخادم:
 *
 *   costPerBase = money(unitPrice) / factor = 150 / 12 = 12.50
 *
 * فيحسب WAVG على تكلفةٍ خطأ ⇒ رصيدُ ٢٣٩ قطعةٍ بـ١٥٠ + استلامُ ١٢ قطعةٍ بـ«١٥٠» يعطي:
 *   جديد = (239 × 150 + 12 × 12.50) / 251 = (35,850 + 150) / 251 = 143.43
 * بدل السليم 150.00.
 *
 * هذه الحزمة تُثبّت **الطرف الخادميّ من العقد**: حين تصل الحمولة الصحيحة (١٨٠٠ للدرزن)،
 * `receivePurchase` يقسم على ١٢ ⇒ costPerBase=١٥٠ و WAVG يبقى ١٥٠. وهي حزامٌ ثانٍ يمسك أيّ
 * انحرافٍ مستقبليّ في مسار الإضافة (ProductSearchBar/BulkPicker) — بأخضرَ حقيقيّ في اختبارٍ
 * ماليّ يقيس WAVG بعد الاستلام، لا في تأكيدٍ نصّيّ على قيمةٍ في الحمولة.
 */

const actor = { userId: 1, branchId: 1, role: "manager" } as const;
const receiver = { userId: 2, branchId: 1, role: "manager" } as const;

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

async function seed(opts: { openingQty: number; openingCost: string }) {
  const d = db();
  await d
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "pur-unit-01-maker",
      name: "منشئ",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "pur-unit-01-recv",
      name: "مستلم",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد الأقلام" });
  await d.insert(s.products).values({ id: 1, name: "قلم أزرق" });
  // WAVG يقرأ `productVariants.costPrice` قبل الحلقة — نبذر التكلفة الافتتاحية.
  await d.insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "PEN-BLUE",
    costPrice: opts.openingCost,
  });
  // وحدتان لنفس المتغيّر: قطعة (أساس) + درزن (معامل ١٢) — مسار PUR-UNIT-01 المُختبَر.
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
      variantId: 1,
      unitName: "درزن",
      conversionFactor: "12",
      isBaseUnit: false,
    },
  ]);
  // رصيدٌ افتتاحيٌّ في الفرع — يشارك في وزنِ WAVG بعد الاستلام.
  if (opts.openingQty > 0) {
    await d.insert(s.branchStock).values({
      branchId: 1,
      variantId: 1,
      quantity: opts.openingQty,
    });
  }
}

async function approveAndReceive(
  purchaseOrderId: number,
  version: number,
  receivedBaseQuantity: number,
) {
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId,
      expectedVersion: version,
      reason: "إرسال أمر اختبار PUR-UNIT-01 للاعتماد",
      requestKey: `pur-unit-01-submit:${randomUUID()}`,
    },
    actor,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `pur-unit-01-approve:${randomUUID()}`,
      approve: true,
      reason: "راجعت السعر واعتمدت الأمر",
    },
    receiver,
    { legacyConfirmOnly: true },
  );
  // بعد الاعتماد نستلم الكمّية بالوحدة الأساس: `receive.ts` يقسم `unitPrice` من صفّ
  // purchaseOrderItems على معامل الوحدة ⇒ الحمولةُ الصحيحة (١٨٠٠ للدرزن) تُنتج costPerBase=١٥٠.
  const items = await db()
    .select({ id: s.purchaseOrderItems.id })
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, purchaseOrderId));
  await receivePurchase(
    {
      purchaseOrderId,
      lines: [
        {
          purchaseOrderItemId: Number(items[0].id),
          receivedBaseQuantity,
        },
      ],
    },
    receiver,
  );
}

async function readVariantCost(variantId: number): Promise<string> {
  const rows = await db()
    .select({ cost: s.productVariants.costPrice })
    .from(s.productVariants)
    .where(eq(s.productVariants.id, variantId));
  return rows[0].cost;
}

describe("PUR-UNIT-01 — سعر شراء الوحدة = تكلفة الأساس × معامل الوحدة", () => {
  it("درزنٌ واحد بسعرِ ١٨٠٠ (السليم) على رصيدِ ٢٣٩ قطعةً بـ١٥٠ ⇒ WAVG يبقى ١٥٠ بالضبط", async () => {
    await reset();
    await seed({ openingQty: 239, openingCost: "150.00" });

    // الحمولةُ الصحيحة بعد PUR-UNIT-01: unitPrice للدرزن = 150 × 12 = 1800.
    // (قبل الإصلاح كانت الشاشة تُرسل ١٥٠ ⇒ costPerBase = 150/12 = 12.50 ⇒ WAVG = 143.43.)
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 2, // الدرزن
            quantity: "1",
            unitPrice: "1800",
          },
        ],
      },
      actor,
    );
    await approveAndReceive(created.purchaseOrderId, created.version, 12);

    // 239 قطعةً بـ150 = 35,850. + 12 قطعةً بـ150 = 1,800. المجموع 37,650 / 251 = 150.00 بالضبط.
    expect(await readVariantCost(1)).toBe("150.00");
  });

  it("العطبُ التاريخيّ للتوثيق: درزنٌ بسعرِ ١٥٠ يُسمّم WAVG إلى ١٤٣٫٤٣", async () => {
    await reset();
    await seed({ openingQty: 239, openingCost: "150.00" });

    // نُحاكي الحمولة الخاطئة (١٥٠ بدل ١٨٠٠) لنُوثّق **مقدار التسمّم** حتى يظهر مقياساً
    // في التاريخ — ولا يعود إحياؤه محلَّ اجتهاد. الطرف الخادميّ صحيح؛ الخطأ في الواجهة.
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 2, // الدرزن
            quantity: "1",
            unitPrice: "150", // ⚠️ الحمولةُ التي كانت تُرسَل — بوحدة الأساس بدل وحدة الصفّ.
          },
        ],
      },
      actor,
    );
    await approveAndReceive(created.purchaseOrderId, created.version, 12);

    // 239 × 150 + 12 × 12.50 = 35,850 + 150 = 36,000. / 251 = 143.4262... ⇒ HALF_UP على 2dp = 143.43.
    expect(await readVariantCost(1)).toBe("143.43");
  });

  it("الوحدة الأساس (قطعة) بلا معامل: السعرُ يمرّ كما هو ⇒ لا انحرافٌ سلوكيّ للمنتجات ذات وحدةٍ واحدة", async () => {
    await reset();
    await seed({ openingQty: 100, openingCost: "150.00" });

    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 1, // القطعة الأساس (معامل ١)
            quantity: "10",
            unitPrice: "150",
          },
        ],
      },
      actor,
    );
    await approveAndReceive(created.purchaseOrderId, created.version, 10);

    // 100 × 150 + 10 × 150 = 16,500 / 110 = 150.00.
    expect(await readVariantCost(1)).toBe("150.00");
  });
});
