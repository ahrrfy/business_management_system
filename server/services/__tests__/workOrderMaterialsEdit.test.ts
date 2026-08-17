/**
 * تحرير بنود أمر الشغل (`setWorkOrderMaterials`) — الفجوة التي اشتكاها المالك (١٧/٨/٢٦):
 * لا مسار كان يضيف منتجاً لأمر شغلٍ أو يحذفه؛ `updateWorkOrder` وصفيٌّ فقط.
 *
 * الثوابت المحروسة هنا:
 *  ① **قبل البدء** (`RECEIVED`): تحريرٌ بلا أيّ أثر مخزنيّ أو دفتريّ — المواد لم تُستهلَك بعد.
 *  ② **بعد البدء** (`IN_PROGRESS`): كل فرقٍ يقابله **حركة مخزون** معاكسة وقيدُ WIP مُكمِّل،
 *     و`materialsCost` يتبع الفرق. لا تعديل صامت على مواد استُهلكت فعلاً.
 *  ③ **idempotency طبيعيّة**: إرسال القائمة نفسها مرّتين ⇒ فرقٌ صفر ⇒ صفر حركة وصفر قيد.
 *     (هذا سبب اختيار العقد التصريحيّ — شبكة الاستقبال متقطّعة وإعادة الإرسال واقعة.)
 *  ④ لقطة التكلفة وقت الاستهلاك لا تتحرّك بتغيّر WAVG بعده.
 *  ⑤ الأمر المُسلَّم لا تُعدَّل بنوده، وبضاعة الأمانة لا تصلح مادةً.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createWorkOrder } from "../workOrder/create";
import { setWorkOrderMaterials } from "../workOrder/materials";
import { startWorkOrder } from "../workOrder/lifecycle";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries", "receipts", "inventoryMovements",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "branchStock", "shifts", "customers",
  "productPrices", "productUnits", "productVariants", "products",
  "branches", "users",
];

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };

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
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    { id: 1, openId: "mgr1", name: "مدير ١", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "c1", name: "كاشير ١", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "عميل أ", defaultPriceTier: "RETAIL", currentBalance: "0" });
  // ثلاث مواد: ورق (١٠٠٠)، حبر (٢٥٠٠)، وأمانةٌ (لا تصلح مادة).
  await d.insert(s.products).values([
    { id: 1, name: "ورق" },
    { id: 2, name: "حبر" },
    { id: 3, name: "صنف أمانة", isConsignment: true, consignorId: null },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PAPER", costPrice: "1000.00" },
    { id: 2, productId: 2, sku: "INK", costPrice: "2500.00" },
    { id: 3, productId: 3, sku: "CONSIGN", costPrice: "500.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 3, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 500 },
    { variantId: 2, branchId: 1, quantity: 500 },
    { variantId: 3, branchId: 1, quantity: 500 },
  ]);
}

async function newWorkOrder(materials: Array<{ variantId: number; baseQuantity: number }>) {
  const res = await createWorkOrder(
    { branchId: 1, customerId: 1, title: "طلب طباعة", salePrice: "50000", quantity: 1, materials },
    CASHIER,
  );
  return (res as { workOrderId: number }).workOrderId;
}

const loadWo = async (id: number) =>
  (await db().select().from(s.workOrders).where(eq(s.workOrders.id, id)).limit(1))[0];

const loadMats = async (id: number) =>
  db().select().from(s.workOrderMaterials).where(eq(s.workOrderMaterials.workOrderId, id));

const stockOf = async (variantId: number) =>
  Number(
    (await db().select().from(s.branchStock).where(and(
      eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, 1),
    )).limit(1))[0]?.quantity ?? 0,
  );

const movementCount = async (workOrderId: number) =>
  (await db().select().from(s.inventoryMovements).where(and(
    eq(s.inventoryMovements.referenceType, "WORK_ORDER"),
    eq(s.inventoryMovements.referenceId, workOrderId),
  ))).length;

const wipEntries = async () =>
  db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));

beforeEach(async () => {
  await reset();
  await seed();
});

describe("① قبل البدء — تحريرٌ بلا أثر مخزنيّ أو دفتريّ", () => {
  it("إضافة صنف وحذف آخر وتغيير كمّية: الصفوف تتبع الطلب والمخزون لا يتحرّك", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    const stockBefore = await stockOf(1);

    const res = await setWorkOrderMaterials(
      { workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 25 }, { variantId: 2, baseQuantity: 4 }] },
      CASHIER,
    );

    expect(res.stockAdjusted).toBe(false);
    expect(res.changed).toEqual([{ variantId: 1, from: 10, to: 25 }]);
    expect(res.added).toEqual([{ variantId: 2, baseQuantity: 4 }]);

    const mats = await loadMats(woId);
    expect(mats).toHaveLength(2);
    // لم تُستهلَك بعد ⇒ لا لقطة تكلفة (تُكتب عند البدء).
    expect(mats.every((m) => Number(m.unitCost) === 0)).toBe(true);
    expect(await stockOf(1)).toBe(stockBefore);
    expect(await movementCount(woId)).toBe(0);
    expect(await wipEntries()).toHaveLength(0);
  });

  it("حذف كل المواد مسموح (قائمة فارغة)", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    const res = await setWorkOrderMaterials({ workOrderId: woId, materials: [] }, CASHIER);
    expect(res.removed).toEqual([{ variantId: 1, baseQuantity: 10 }]);
    expect(await loadMats(woId)).toHaveLength(0);
  });

  it("يوسم الأمر «مُعدَّل» بعدّاد يتصاعد — لا يُشتقّ من updatedAt", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    expect(Number((await loadWo(woId)).materialsEditCount)).toBe(0);

    await setWorkOrderMaterials({ workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 11 }] }, CASHIER);
    await setWorkOrderMaterials({ workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 12 }] }, CASHIER);

    const wo = await loadWo(woId);
    expect(Number(wo.materialsEditCount)).toBe(2);
    expect(Number(wo.materialsEditedBy)).toBe(CASHIER.userId);
    expect(wo.materialsEditedAt).toBeTruthy();
  });
});

describe("② بعد البدء — كل فرقٍ يقابله حركةٌ وقيدٌ مُكمِّل", () => {
  it("زيادة الكمّية تستهلك الفرق من الرفّ وترفع materialsCost وترحّل WIP بالفرق وحده", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]); // 10 × 1000 = 10,000
    await startWorkOrder(woId, CASHIER);
    expect(Number((await loadWo(woId)).materialsCost)).toBeCloseTo(10000, 2);
    const stockAfterStart = await stockOf(1); // 500 − 10 = 490

    const res = await setWorkOrderMaterials(
      { workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 15 }] },
      CASHIER,
    );

    expect(res.stockAdjusted).toBe(true);
    expect(await stockOf(1)).toBe(stockAfterStart - 5); // الفرق وحده خرج
    expect(Number(res.materialsCost)).toBeCloseTo(15000, 2);

    // قيدان: استهلاك البدء (10,000) + المُكمِّل (5,000) — لا إعادة ترحيلٍ للإجمالي.
    const adjusts = await wipEntries();
    expect(adjusts).toHaveLength(2);
    const delta = adjusts.find((e) => Number(e.amount) === 5000);
    expect(delta).toBeTruthy();
  });

  it("حذف مادة بعد البدء يعيدها للرفّ ويعكس حصّتها من WIP بقيدٍ سالب", async () => {
    const woId = await newWorkOrder([
      { variantId: 1, baseQuantity: 10 },
      { variantId: 2, baseQuantity: 4 },
    ]); // 10,000 + 10,000 = 20,000
    await startWorkOrder(woId, CASHIER);
    const inkAfterStart = await stockOf(2); // 500 − 4 = 496

    const res = await setWorkOrderMaterials(
      { workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 10 }] },
      CASHIER,
    );

    expect(res.removed).toEqual([{ variantId: 2, baseQuantity: 4 }]);
    expect(await stockOf(2)).toBe(inkAfterStart + 4); // عادت للرفّ كاملةً
    expect(Number(res.materialsCost)).toBeCloseTo(10000, 2);
    const negative = (await wipEntries()).find((e) => Number(e.amount) === -10000);
    expect(negative).toBeTruthy(); // عكسٌ صريح لا حذفٌ صامت
  });

  it("④ لقطة التكلفة تثبت: تغيّر WAVG بعد البدء لا يحرّك قيمة ما استُهلك", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    await startWorkOrder(woId, CASHIER); // لقطة 1000

    // ارتفع سعر الشراء لاحقاً — يجب ألّا يمسّ حصّة هذا الأمر.
    await db().update(s.productVariants).set({ costPrice: "9999.00" }).where(eq(s.productVariants.id, 1));

    const res = await setWorkOrderMaterials(
      { workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 11 }] },
      CASHIER,
    );
    // الفرق قطعةٌ واحدة بلقطة 1000 لا بـ9999.
    expect(Number(res.materialsCost)).toBeCloseTo(11000, 2);
  });
});

describe("③ idempotency طبيعيّة + حرّاس", () => {
  it("إرسال القائمة نفسها مرّتين: الثانية صفر حركة وصفر قيد", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    await startWorkOrder(woId, CASHIER);

    const desired = [{ variantId: 1, baseQuantity: 15 }];
    await setWorkOrderMaterials({ workOrderId: woId, materials: desired }, CASHIER);
    const movementsAfterFirst = await movementCount(woId);
    const entriesAfterFirst = (await wipEntries()).length;
    const stockAfterFirst = await stockOf(1);

    const second = await setWorkOrderMaterials({ workOrderId: woId, materials: desired }, CASHIER);

    expect(second.stockAdjusted).toBe(false);
    expect(second.added).toEqual([]);
    expect(second.changed).toEqual([]);
    expect(await movementCount(woId)).toBe(movementsAfterFirst);
    expect((await wipEntries()).length).toBe(entriesAfterFirst);
    expect(await stockOf(1)).toBe(stockAfterFirst);
    // والعدّاد لا يتضخّم بإعادة إرسالٍ لم تغيّر شيئاً.
    expect(Number((await loadWo(woId)).materialsEditCount)).toBe(1);
  });

  it("بضاعة الأمانة لا تصلح مادةً — تُرفض ولا تُكتب", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    await expect(setWorkOrderMaterials(
      { workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 10 }, { variantId: 3, baseQuantity: 2 }] },
      CASHIER,
    )).rejects.toThrowError(/الأمانة/);
    expect(await loadMats(woId)).toHaveLength(1);
  });

  it("كمّية غير صحيحة أو صفرية مرفوضة (الحذف بإسقاط الصنف لا بصفر)", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    await expect(setWorkOrderMaterials(
      { workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 0 }] },
      CASHIER,
    )).rejects.toThrowError(/صحيحاً موجباً/);
  });

  it("أمرٌ مُسلَّم لا تُعدَّل بنوده", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    await db().update(s.workOrders).set({ status: "DELIVERED" }).where(eq(s.workOrders.id, woId));
    await expect(setWorkOrderMaterials(
      { workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 5 }] },
      CASHIER,
    )).rejects.toThrowError(/مُسلَّم/);
  });

  it("عزل الفرع: كاشير فرعٍ آخر لا يعدّل بنود أمرٍ ليس لفرعه", async () => {
    const woId = await newWorkOrder([{ variantId: 1, baseQuantity: 10 }]);
    await expect(setWorkOrderMaterials(
      { workOrderId: woId, materials: [{ variantId: 1, baseQuantity: 5 }] },
      { userId: 2, branchId: 99, role: "cashier" },
    )).rejects.toThrowError(/لا يخصّ فرعك/);
  });
});
