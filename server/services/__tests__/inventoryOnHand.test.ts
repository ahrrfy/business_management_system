import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";

const TABLES = [
  "auditLogs",
  "accountingEntries",
  "stockAdjustmentRequests",
  "inventoryMovements",
  "branchStock",
  "productUnitBarcodes",
  "productUnits",
  "productImages",
  "productVariants",
  "products",
  "users",
  "branches",
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
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.local", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "local_wh", name: "مخزن", email: "wh@t.local", role: "warehouse", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق A4" });
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SKU-1", variantName: "عادي", minStock: 10 },
    { id: 2, productId: 1, sku: "SKU-2", variantName: "فاخر", minStock: 0 },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 10,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
      barcode: "6290000000200",
    },
    {
      id: 12,
      variantId: 2,
      unitName: "حزمة",
      conversionFactor: "10",
      isBaseUnit: false,
      barcode: "LOT 2026 B",
    },
  ]);
  await d.insert(s.productUnitBarcodes).values([
    { id: 11, productUnitId: 10, barcode: "6290000000299" },
    { id: 13, productUnitId: 12, barcode: "ALT LOT 2026 B" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 5 }, // تحت الحد الأدنى (10)
    { variantId: 2, branchId: 1, quantity: 100 },
    { variantId: 1, branchId: 2, quantity: 50 }, // فرع آخر
  ]);
}

function makeCtx(user: any) {
  const res = { cookie() {}, clearCookie() {} };
  const req = { headers: {} as Record<string, string> };
  return { req, res, user } as any;
}

async function userRow(id: number) {
  return (await db().select().from(s.users).where(eq(s.users.id, id)).limit(1))[0];
}

/** يبذر خدمةً وبكجاً (بلا صفّ رصيد) لاختبارات «لا تظهر زوراً كصفريّات كتالوجيّة». */
async function d_seedNonStockables() {
  await db().insert(s.products).values([
    { id: 90, name: "كارت زين رقميّ", isActive: true, isService: true, isBundle: false, isConsignment: false },
    { id: 91, name: "بكج البداية", isActive: true, isService: false, isBundle: true, isConsignment: false },
  ]);
  await db().insert(s.productVariants).values([
    { id: 499, productId: 90, sku: "SVC-DIGITAL-CARD", isActive: true },
    { id: 500, productId: 91, sku: "PKG-STARTER-BUNDLE", isActive: true },
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("inventory.onHand", () => {
  it("يعرض الأرصدة بالأسماء وعلم «تحت الحد الأدنى»", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    expect(rows).toHaveLength(2);
    const v1 = rows.find((r) => Number(r.variantId) === 1)!;
    const v2 = rows.find((r) => Number(r.variantId) === 2)!;
    expect(v1.productName).toBe("ورق A4");
    expect(v1.quantity).toBe(5);
    expect(v1.isLow).toBe(true);
    expect(v2.quantity).toBe(100);
    expect(v2.isLow).toBe(false);
  });

  it("lowOnly يُرجع المنخفض فقط", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1, lowOnly: true });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].variantId)).toBe(1);
  });

  it("البحث يطابق اسم المنتج وSKU", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    expect(await caller.inventory.onHand({ branchId: 1, q: "A4" })).toHaveLength(2);
    const bySku = await caller.inventory.onHand({ branchId: 1, q: "SKU-2" });
    expect(bySku).toHaveLength(1);
    expect(Number(bySku[0].variantId)).toBe(2);
  });

  it("يعرض الصنف القابل للتسوية عند البحث بباركوده الأساسي أو البديل", async () => {
    await db().insert(s.products).values({
      id: 3,
      name: "000 6290000000200 6290000000299 LOT 2026 B ALT LOT 2026 B",
    });
    await db().insert(s.productVariants).values({
      id: 3,
      productId: 3,
      sku: "DISTRACTOR",
      variantName: "مطابقة نصية عَرَضية",
    });

    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const byPrimary = await caller.inventory.onHand({ branchId: 1, q: "6290000000200", limit: 1 });
    const byAlias = await caller.inventory.onHand({ branchId: 1, q: "6290000000299", limit: 1 });
    const bySpacedPrimary = await caller.inventory.onHand({ branchId: 1, q: "LOT 2026 B", limit: 1 });
    const bySpacedAlias = await caller.inventory.onHand({ branchId: 1, q: "ALT LOT 2026 B", limit: 1 });

    expect(byPrimary.map((r) => Number(r.variantId))).toEqual([2]);
    expect(byAlias.map((r) => Number(r.variantId))).toEqual([2]);
    expect(bySpacedPrimary.map((r) => Number(r.variantId))).toEqual([2]);
    expect(bySpacedAlias.map((r) => Number(r.variantId))).toEqual([2]);
    expect(byPrimary[0]?.quantity).toBe(100);
    expect(byAlias[0]?.quantity).toBe(100);
    expect(byPrimary[0]?.scanMatch).toEqual({
      kind: "PRIMARY",
      scannedBarcode: "6290000000200",
      primaryBarcode: "6290000000200",
      unitName: "قطعة",
      factor: 1,
    });
    expect(byAlias[0]?.scanMatch).toEqual({
      kind: "ALIAS",
      scannedBarcode: "6290000000299",
      primaryBarcode: "6290000000200",
      unitName: "قطعة",
      factor: 1,
    });
    expect(bySpacedPrimary[0]?.scanMatch).toEqual({
      kind: "PRIMARY",
      scannedBarcode: "LOT 2026 B",
      primaryBarcode: "LOT 2026 B",
      unitName: "حزمة",
      factor: 10,
    });
    expect(bySpacedAlias[0]?.scanMatch).toEqual({
      kind: "ALIAS",
      scannedBarcode: "ALT LOT 2026 B",
      primaryBarcode: "LOT 2026 B",
      unitName: "حزمة",
      factor: 10,
    });
  });

  it("يحسم إرث الباركود الملوّث وتكافؤ UPC-A/EAN-13 قبل المطابقة النصية العَرَضية", async () => {
    await db().insert(s.productUnits).values([
      {
        id: 20,
        variantId: 2,
        unitName: "مورد",
        conversionFactor: "1",
        isBaseUnit: false,
        barcode: " 10095\t",
      },
      {
        id: 21,
        variantId: 2,
        unitName: "UPC",
        conversionFactor: "1",
        isBaseUnit: false,
        barcode: "0036000291452",
      },
      { id: 22, variantId: 2, unitName: "ملصق المورد", conversionFactor: "1", isBaseUnit: false, barcode: "1  0095" },
    ]);
    await db().insert(s.products).values({ id: 3, name: "000 10095 036000291452" });
    await db().insert(s.productVariants).values({ id: 3, productId: 3, sku: "DISTRACTOR" });

    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const healed = await caller.inventory.onHand({ branchId: 1, q: "10095", limit: 1 });
    const upc = await caller.inventory.onHand({ branchId: 1, q: "036000291452", limit: 1 });
    const supplierLabel = await caller.inventory.onHand({ branchId: 1, q: "1  0095", limit: 1 });

    expect(healed.map((row) => Number(row.variantId))).toEqual([2]);
    expect(healed[0]?.scanMatch?.unitName).toBe("مورد");
    expect(upc.map((row) => Number(row.variantId))).toEqual([2]);
    expect(upc[0]?.scanMatch?.unitName).toBe("UPC");
    expect(supplierLabel.map((row) => Number(row.variantId))).toEqual([2]);
    expect(supplierLabel[0]?.scanMatch?.scannedBarcode).toBe("1  0095");
  });

  it("يفشل مغلقاً إذا امتلك UPC-A وEAN-13 المكافئ وحدتان مختلفتان", async () => {
    await db().update(s.productUnits).set({ barcode: "0036000291452" }).where(eq(s.productUnits.id, 10));
    await db().update(s.productUnits).set({ barcode: "036000291452" }).where(eq(s.productUnits.id, 12));
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    await expect(caller.inventory.onHand({ branchId: 1, q: "036000291452", limit: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("لا يرفق scanMatch لبحث نصي غير حرفي", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1, q: "SKU-2" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scanMatch).toBeNull();
  });

  it("يعيد هوية بصرية خفيفة للتسوية: صورة المتغيّر أولاً وباركود الوحدة الأساس", async () => {
    const image = "data:image/png;base64,iVBORw0KGgo=";
    await db().insert(s.productImages).values([
      { id: 80, productId: 1, url: image, isPrimary: true },
      { id: 81, productId: 1, variantId: 2, url: image, isPrimary: false },
    ]);

    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    const plain = rows.find((r) => Number(r.variantId) === 1)!;
    const luxury = rows.find((r) => Number(r.variantId) === 2)!;

    expect(plain.imageUrl).toMatch(/^\/api\/img\/inventory-product\/80\?v=[0-9a-f]{16}$/);
    expect(luxury.imageUrl).toMatch(/^\/api\/img\/inventory-product\/81\?v=[0-9a-f]{16}$/);
    expect(plain.primaryBarcode).toBeNull();
    expect(luxury.primaryBarcode).toBe("6290000000200");
    expect(luxury.imageUrl).not.toContain("base64");
  });

  it("لا يُسرّب التكلفة في المخرجات", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    for (const r of rows) expect("costPrice" in r).toBe(false);
  });

  it("عزل الفرع: مستخدم المخزن مقيَّد بفرعه ويتجاهل branchId المُرسَل — لا تسريب أرصدة الفرع الآخر", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(2))); // warehouse, branch 2
    const rows = await caller.inventory.onHand({ branchId: 1 }); // يحاول فرع 1
    // بعد إصلاح ٢٤/٨ (LEFT JOIN من الكتالوج): يرى **كل** الكتالوج النشط برصيد فرعه ٢
    // — v1 له صفٌّ في فرع ٢ (50)، وv2 بلا صفٍّ لفرع ٢ (⇒ 0). فرع ١ رقم 100 لا يُرى.
    // مقياس الحرص: `branchId` في كلّ صفٍّ = 2، والأرصدة لا تشمل رقم فرع ١ (100).
    expect(rows.every((r) => Number(r.branchId) === 2)).toBe(true);
    const quantities = rows.map((r) => r.quantity).sort((a, b) => a - b);
    // مقبول: [0 (v2 بلا صفٍّ لفرع ٢), 50 (v1 بفرع ٢)]. ممنوع صراحةً: 100 (رصيد v2 في فرع ١) أو 5 (رصيد v1 في فرع ١).
    expect(quantities).not.toContain(100);
    expect(quantities).not.toContain(5);
    expect(quantities).toContain(50);
  });

  /* ─────────── بلاغ المالك ٢٤/٨: LEFT JOIN من الكتالوج (لا INNER من branchStock) ─────────── */

  it("يُظهر متغيّراً لم يُلامَس بحركةٍ في الفرع (لا صفَّ branchStock) بـquantity=0 — بلاغ المالك", async () => {
    // نضيف متغيّراً جديداً لمنتج قائم بلا صفّ رصيدٍ لأيّ فرع (كأنّه أُدخل الكتالوج ولم يُشترَ بعد)
    await db().insert(s.productVariants).values({
      id: 99,
      productId: 1,
      sku: "ENV-COLDEN-110",
      variantName: "ظرف ابيض 110×220 COLDEN 8S8643P-AA1",
      minStock: 0,
      isActive: true,
    });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    const envelope = rows.find((r) => r.sku === "ENV-COLDEN-110");
    expect(envelope).toBeDefined(); // كان يختفي قبل الإصلاح (INNER JOIN)
    expect(envelope?.quantity).toBe(0);
    expect(envelope?.lastCountedAt).toBeNull();
    // الآن المدير يستطيع فتح تسوية على هذا الصنف من نفس الشاشة (Inventory.tsx).
  });

  it("البحث يجد المتغيّر بلا صفّ branchStock (سيناريو «أعرف اسمه لكن لا يظهر»)", async () => {
    await db().insert(s.productVariants).values({
      id: 100,
      productId: 1,
      sku: "ORPHAN-SKU",
      variantName: "متغيّر بلا رصيد",
      isActive: true,
    });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const bySku = await caller.inventory.onHand({ branchId: 1, q: "ORPHAN-SKU" });
    expect(bySku).toHaveLength(1);
    expect(bySku[0].quantity).toBe(0);
  });

  it("lowOnly لا يُصنّف المتغيّر بلا صفٍّ «تحت الحدّ» (منع فيضان الفلتر)", async () => {
    await db().insert(s.productVariants).values({
      id: 101,
      productId: 1,
      sku: "NOSTOCK-LOW",
      variantName: "لا رصيد وحدّه 50",
      minStock: 50,
      isActive: true,
    });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const low = await caller.inventory.onHand({ branchId: 1, lowOnly: true });
    // فقط v1 (رصيد 5 وحدّه 10). NOSTOCK-LOW له NULL quantity ⇒ يسقط من الفلتر.
    expect(low.map((r) => r.sku).sort()).toEqual(["SKU-1"]);
  });

  it("negativeOnly لا يشمل المتغيّر بلا صفّ (NULL ليس <0)", async () => {
    await db().insert(s.productVariants).values({
      id: 102,
      productId: 1,
      sku: "NOSTOCK-NEG",
      variantName: "لا رصيد — ليس سالباً",
      isActive: true,
    });
    // نجعل v1 سالباً للتأكيد
    await db().update(s.branchStock).set({ quantity: -3 }).where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const neg = await caller.inventory.onHand({ branchId: 1, negativeOnly: true });
    expect(neg.map((r) => r.sku).sort()).toEqual(["SKU-1"]);
  });

  it("يستبعد المتغيّر/المنتج غير النشط **الذي لا رصيد له** (كتالوجٌ نظيف)", async () => {
    await db().insert(s.products).values({ id: 9, name: "منتج معطَّل", isActive: false });
    await db().insert(s.productVariants).values([
      { id: 200, productId: 9, sku: "INACTIVE-PROD-NOSTOCK", isActive: true },
      { id: 201, productId: 1, sku: "INACTIVE-VAR-NOSTOCK", isActive: false },
    ]);
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    const skus = rows.map((r) => r.sku);
    expect(skus).not.toContain("INACTIVE-PROD-NOSTOCK");
    expect(skus).not.toContain("INACTIVE-VAR-NOSTOCK");
  });

  it("يُظهر الصنف المُعطَّل **إن كان له صفّ رصيد** (توافقٌ عكسيٌّ — مراجعة Codex P2 على إخفاء الرصيد بعد التعطيل)", async () => {
    // متغيّرٌ صار غير نشط لكنّه لا يزال يحمل رصيداً في الفرع ⇒ لا بدّ أن يبقى ظاهراً كي
    // يستطيع المدير تسويته من الشاشة (setProductActive لا يشترط رصيداً صفرياً قبل التعطيل).
    await db().insert(s.productVariants).values({
      id: 400,
      productId: 1,
      sku: "INACTIVE-WITH-STOCK",
      isActive: false,
    });
    await db().insert(s.branchStock).values({ variantId: 400, branchId: 1, quantity: 12 });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    const stale = rows.find((r) => r.sku === "INACTIVE-WITH-STOCK");
    expect(stale).toBeDefined();
    expect(stale?.quantity).toBe(12);
  });

  it("لا يُدرج الخدمات/البكجات كصفريّات كتالوجيّة زائفة (زرّ التسوية يفشل عليها — مراجعة Codex P2)", async () => {
    // خدمة (كارت رقميّ) وبكج — كلاهما بلا رصيدٍ لأيّ فرع. LEFT JOIN الوسيع كان
    // سيُدرجهما كصفريّاتٍ صالحة للتسوية، والزرّ سيفشل لأنّ `setStock` يرفض الخدمة/البكج.
    await d_seedNonStockables();
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    const skus = rows.map((r) => r.sku);
    expect(skus).not.toContain("SVC-DIGITAL-CARD");
    expect(skus).not.toContain("PKG-STARTER-BUNDLE");
  });

  it("لكن يُظهر البكج/الخدمة **إن كان لهما صفّ رصيدٍ فعليّ** (بكجٌ من الإنتاج مثلاً — التوافق العكسيّ)", async () => {
    await d_seedNonStockables();
    // نُنشئ صفّ رصيدٍ للبكج (كأنّ عمليةَ إنتاج ركّبت وحدة) ⇒ يجب أن يبقى ظاهراً بالسلوك القديم.
    await db().insert(s.branchStock).values({ variantId: 500, branchId: 1, quantity: 3 });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rows = await caller.inventory.onHand({ branchId: 1 });
    const bundle = rows.find((r) => r.sku === "PKG-STARTER-BUNDLE");
    expect(bundle).toBeDefined();
    expect(bundle?.quantity).toBe(3);
  });

  it("تطابق فلتر lowOnly وشارة isLow: الصنف بلا صفّ رصيد لا يُصنّف «تحت الحدّ» في الاثنين معاً — مراجعة Codex P2", async () => {
    await db().insert(s.productVariants).values({
      id: 600,
      productId: 1,
      sku: "LOW-CONSISTENCY",
      variantName: "لا رصيد وحدّه 50",
      minStock: 50,
      isActive: true,
    });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));

    // بلا فلتر: الصنف يظهر (كتالوج نشط قابل للجرد) لكنّ isLow=false (لا صفَّ فعلي).
    const all = await caller.inventory.onHand({ branchId: 1 });
    const cat = all.find((r) => r.sku === "LOW-CONSISTENCY");
    expect(cat).toBeDefined();
    expect(cat?.quantity).toBe(0);
    expect(cat?.isLow).toBe(false); // تطابق مع lowOnly

    // مع فلتر lowOnly: لا يظهر (فلاتر مبنيّة على الحقل الخام NULL).
    const low = await caller.inventory.onHand({ branchId: 1, lowOnly: true });
    expect(low.map((r) => r.sku)).not.toContain("LOW-CONSISTENCY");
  });

  it("رصيد الفرع الآخر لا يُفسِد عدّ الفرع المطلوب (شرط الفرع في ON لا WHERE)", async () => {
    await db().insert(s.productVariants).values({
      id: 300,
      productId: 1,
      sku: "OTHER-BRANCH-ONLY",
      variantName: "له رصيد بفرع ٢ فقط",
      isActive: true,
    });
    await db().insert(s.branchStock).values({ variantId: 300, branchId: 2, quantity: 77 });
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const rowsBranch1 = await caller.inventory.onHand({ branchId: 1 });
    const other = rowsBranch1.find((r) => r.sku === "OTHER-BRANCH-ONLY");
    // الصنف يظهر في فرع ١ بـ0 (LEFT JOIN مع شرط branch في ON)
    expect(other).toBeDefined();
    expect(other?.quantity).toBe(0);
    // فرع ٢ يعرضه بـ77
    const admin1WithScope = appRouter.createCaller(makeCtx(await userRow(1)));
    const rowsBranch2 = await admin1WithScope.inventory.onHand({ branchId: 2 });
    const otherAt2 = rowsBranch2.find((r) => r.sku === "OTHER-BRANCH-ONLY");
    expect(otherAt2?.quantity).toBe(77);
  });
});

describe("inventory.adjust (طلب معلَّق ثم اعتماد — فصل مهام #٦)", () => {
  it("adjust يُنشئ طلباً معلَّقاً بلا تغيير، والاعتماد يضبط الرصيد + حركة ADJUST + تدقيق", async () => {
    const caller = appRouter.createCaller(makeCtx(await userRow(1)));
    const qOf = async () => (await caller.inventory.onHand({ branchId: 1 })).find((r) => Number(r.variantId) === 1)!.quantity;
    const initial = await qOf();

    const req = await caller.inventory.adjust({ variantId: 1, branchId: 1, targetQuantity: 30, notes: "جرد" });
    expect(req.status).toBe("PENDING_APPROVAL");
    expect(await qOf()).toBe(initial); // لا تغيير مخزون قبل الاعتماد

    // admin يعتمد طلبه (مُستثنى من SOD) ⇒ يُطبَّق.
    await caller.inventory.approveAdjustment({ id: req.requestId });
    expect(await qOf()).toBe(30);

    const mv = await db()
      .select()
      .from(s.inventoryMovements)
      .where(and(eq(s.inventoryMovements.variantId, 1), eq(s.inventoryMovements.movementType, "ADJUST")))
      .limit(1);
    expect(mv).toHaveLength(1);
    expect(mv[0].quantity).toBe(Math.abs(30 - initial));

    const audit = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "inventory.adjustApprove"))
      .limit(1);
    expect(audit).toHaveLength(1);
  });
});

describe("inventory.pendingAdjustments/rejectAdjustment — عزل الفرع + الرفض (متابعات المراجعة)", () => {
  it("S3: غير الأدمن بلا فرع مُسنَد ⇒ FORBIDDEN (لا قراءة طلبات عبر الفروع)", async () => {
    await db().insert(s.users).values({ id: 3, openId: "nb_mgr", name: "مدير بلا فرع", role: "manager", loginMethod: "local", branchId: null });
    const caller = appRouter.createCaller(makeCtx(await userRow(3)));
    await expect(caller.inventory.pendingAdjustments({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("R4: رفض طلب تسوية ⇒ REJECTED بلا تغيير مخزون + تدقيق", async () => {
    const admin = appRouter.createCaller(makeCtx(await userRow(1)));
    const qOf = async () => (await admin.inventory.onHand({ branchId: 1 })).find((r) => Number(r.variantId) === 1)!.quantity;
    const before = await qOf();
    const req = await admin.inventory.adjust({ variantId: 1, branchId: 1, targetQuantity: 99 });
    await admin.inventory.rejectAdjustment({ id: req.requestId, reason: "خطأ إدخال" });
    expect(await qOf()).toBe(before); // بلا تطبيق
    const [row] = await db().select().from(s.stockAdjustmentRequests).where(eq(s.stockAdjustmentRequests.id, req.requestId));
    expect(row.status).toBe("REJECTED");
    const audit = await db().select().from(s.auditLogs).where(eq(s.auditLogs.action, "inventory.adjustReject")).limit(1);
    expect(audit).toHaveLength(1);
  });
});
