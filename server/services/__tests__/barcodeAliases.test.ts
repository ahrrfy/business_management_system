// اختبارات باركودات بديلة (aliases) — نفس السلعة/التكلفة/السعر/المخزون بعدّة باركودات.
// تُغطّي ثوابت السلامة الثلاثة الأساسية:
//   A1: الأساسيّ + البديل يشيران للوحدة نفسها ⇒ lookupByBarcode يحلّ الاثنين إلى POS row واحد.
//   A2: تفرّد عالميّ — باركود موجود كأساسيّ لسلعة أخرى، أو بديلاً لسلعة أخرى، يُرفض عند الإضافة كبديل.
//   A3: حذف الوحدة يحذف بدائلها بـcascade (بلا orphan aliases).
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { truncateTables } from "./__testUtils__";
import {
  addUnitBarcodeAlias,
  checkBarcodesTakenAcrossBoth,
  findBarcodeClashes,
  listUnitBarcodes,
  migrateAliases,
  removeUnitBarcodeAlias,
  resolveBarcodeOwner,
  resolveProductUnitId,
} from "../catalog/barcodeAliases";
import { assignBarcode } from "../catalog/barcode";
import { createProduct } from "../catalog/productCreate";
import { lookupByBarcode } from "../catalog/pos";
import { kioskLookup } from "../kioskService";

const TABLES = [
  "productUnitBarcodes", "productPrices", "productUnits", "productVariants", "productImages", "products",
  "branchStock", "auditLogs", "categories", "users", "branches",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() { await truncateTables(TABLES); }

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  // منتج بسيط: قلم أزرق بأشكال خارجية متعدّدة (SKU واحد، تكلفة واحدة، سعر واحد).
  await d.insert(s.products).values([{ id: 1, name: "قلم أزرق" }, { id: 2, name: "قلم أحمر" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "150.00" },
    { id: 2, productId: 2, sku: "PEN-RED", costPrice: "150.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", barcode: "6001000000017", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", barcode: "6001000000024", isBaseUnit: false },
    { id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", barcode: "6001000000031", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 3, priceTier: "RETAIL", price: "500.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 50 },
  ]);
}

describe("barcodeAliases — ثوابت السلامة", () => {
  beforeEach(async () => { await reset(); await seedBase(); });

  describe("A1: البحث يمرّ على الأساسيّ والبديل معاً", () => {
    it("resolveBarcodeOwner يعيد نفس الوحدة للأساسيّ", async () => {
      const owner = await resolveBarcodeOwner(db(), "6001000000017");
      expect(owner).not.toBeNull();
      expect(owner!.productUnitId).toBe(1);
    });

    it("resolveBarcodeOwner يعيد نفس الوحدة للبديل بعد الإضافة", async () => {
      await addUnitBarcodeAlias(1, "9990000000001", "شكل ٢", 1);
      const owner = await resolveBarcodeOwner(db(), "9990000000001");
      expect(owner).not.toBeNull();
      expect(owner!.productUnitId).toBe(1);
      expect(owner!.productName).toBe("قلم أزرق");
    });

    it("lookupByBarcode (POS) يحلّ البديل إلى نفس صفّ POS للأساسيّ", async () => {
      await addUnitBarcodeAlias(1, "8880000000002", "دفعة استيراد ٢", 1);
      const primaryRow = await lookupByBarcode("6001000000017", 1, "RETAIL");
      const aliasRow = await lookupByBarcode("8880000000002", 1, "RETAIL");
      expect(primaryRow).not.toBeNull();
      expect(aliasRow).not.toBeNull();
      expect(aliasRow!.productUnitId).toBe(primaryRow!.productUnitId);
      expect(aliasRow!.price).toBe(primaryRow!.price);
      expect(aliasRow!.stockBase).toBe(primaryRow!.stockBase);
      expect(aliasRow!.sku).toBe(primaryRow!.sku);
    });

    it("resolveBarcodeOwner يعيد null لباركود غير موجود", async () => {
      const owner = await resolveBarcodeOwner(db(), "0000000000000");
      expect(owner).toBeNull();
    });
  });

  describe("A2: تفرّد عالميّ بين الأساسيّ والبديل", () => {
    it("رفض إضافة بديل يطابق أساسيّاً لسلعة أخرى", async () => {
      // "6001000000031" هو أساسيّ للقلم الأحمر — رفضه كبديل للأزرق.
      await expect(
        addUnitBarcodeAlias(1, "6001000000031", null, 1),
      ).rejects.toThrow(/مُستعمَل|CONFLICT/);
    });

    it("رفض إضافة بديل يطابق بديلاً لسلعة أخرى", async () => {
      await addUnitBarcodeAlias(3, "7770000000003", null, 1);
      await expect(
        addUnitBarcodeAlias(1, "7770000000003", null, 1),
      ).rejects.toThrow(/مُستعمَل|CONFLICT/);
    });

    it("رفض إضافة بديل يطابق الأساسيّ للوحدة نفسها", async () => {
      await expect(
        addUnitBarcodeAlias(1, "6001000000017", null, 1),
      ).rejects.toThrow(/الأساسيّ|CONFLICT/);
    });

    it("checkBarcodesTakenAcrossBoth يكشف الأساسيّات والبدائل معاً", async () => {
      await addUnitBarcodeAlias(1, "9990000000009", "شكل ٣", 1);
      const taken = await checkBarcodesTakenAcrossBoth([
        "6001000000017",   // أساسيّ
        "9990000000009",   // بديل
        "1234567890123",   // حرّ
      ]);
      const codes = taken.map((t) => t.code).sort();
      expect(codes).toEqual(["6001000000017", "9990000000009"]);
    });
  });

  describe("A3: cascade + إدارة القائمة", () => {
    it("listUnitBarcodes يعيد الأساسيّ + كل البدائل مرتّبة زمنياً", async () => {
      await addUnitBarcodeAlias(1, "9990000000001", "شكل ١", 1);
      await addUnitBarcodeAlias(1, "9990000000002", "شكل ٢", 1);
      const list = await listUnitBarcodes(1);
      expect(list.primary).toBe("6001000000017");
      expect(list.aliases).toHaveLength(2);
      expect(list.aliases.map((a) => a.barcode).sort()).toEqual(["9990000000001", "9990000000002"]);
      expect(list.aliases.find((a) => a.barcode === "9990000000001")?.note).toBe("شكل ١");
    });

    it("removeUnitBarcodeAlias يحذف بديلاً بدقّة (لا يمسّ الأساسيّ ولا البدائل الأخرى)", async () => {
      await addUnitBarcodeAlias(1, "9990000000001", null, 1);
      await addUnitBarcodeAlias(1, "9990000000002", null, 1);
      const before = await listUnitBarcodes(1);
      const targetId = before.aliases.find((a) => a.barcode === "9990000000001")!.id;
      await removeUnitBarcodeAlias(targetId);
      const after = await listUnitBarcodes(1);
      expect(after.primary).toBe("6001000000017");
      expect(after.aliases).toHaveLength(1);
      expect(after.aliases[0].barcode).toBe("9990000000002");
    });

    it("حذف وحدة المنتج يحذف كل بدائلها (FK cascade)", async () => {
      await addUnitBarcodeAlias(1, "9990000000001", null, 1);
      await addUnitBarcodeAlias(1, "9990000000002", null, 1);
      // ثبّت FK_CHECKS على نفس اتصال الحذف/القراءة: بعض fixtures القديمة تغيّره
      // على اتصال pool آخر، واختبار القيد يجب ألا يعتمد على حالة جلسة متسرّبة.
      await db().transaction(async (tx) => {
        await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
        await tx.delete(s.productUnits).where(eq(s.productUnits.id, 1));
        const orphans = await tx
          .select({ id: s.productUnitBarcodes.id })
          .from(s.productUnitBarcodes)
          .where(eq(s.productUnitBarcodes.productUnitId, 1));
        expect(orphans).toHaveLength(0);
      });
    });

    it("resolveProductUnitId يحلّ (variantId + unitName) → productUnitId", async () => {
      expect(await resolveProductUnitId(1, "قطعة")).toBe(1);
      expect(await resolveProductUnitId(1, "درزن")).toBe(2);
      expect(await resolveProductUnitId(1, "غير موجود")).toBeNull();
    });
  });

  describe("A4: كل مسارات المسح تجد البديل (kiosk + globalSearch)", () => {
    it("kioskLookup يجد البديل كالأساسيّ (نفس السعر والوحدة)", async () => {
      await addUnitBarcodeAlias(1, "5550000000005", "شكل ٢", 1);
      const primary = await kioskLookup("6001000000017", 1);
      const alias = await kioskLookup("5550000000005", 1);
      expect(primary).not.toBeNull();
      expect(alias).not.toBeNull();
      expect(alias!.productName).toBe(primary!.productName);
      expect(alias!.price).toBe(primary!.price);
      expect(alias!.unitName).toBe(primary!.unitName);
    });
  });

  describe("A5: assignBarcode يفحص البدائل ⛔ (Codex P1)", () => {
    it("لا يسمح بإسناد باركود يطابق بديلاً لسلعة أخرى", async () => {
      await addUnitBarcodeAlias(1, "4440000000004", "بديل الأزرق", 1);
      // نحاول إسناد الباركود نفسه كأساسيّ لوحدة القلم الأحمر (id=3) ⇒ يجب أن يفشل.
      await expect(assignBarcode(3, "4440000000004")).rejects.toThrow(/مُستخدَم|CONFLICT/);
    });
    it("يسمح بإعادة تعيين نفس الباركود لنفس الوحدة (تحديث ذاتيّ)", async () => {
      await expect(assignBarcode(1, "6001000000017")).resolves.toMatchObject({ productUnitId: 1 });
    });
  });

  describe("A6: نقل البدائل عند إعادة تسمية الوحدة (Codex P2-3)", () => {
    it("migrateAliases ينقل كل البدائل من وحدة إلى أخرى", async () => {
      await addUnitBarcodeAlias(1, "3330000000001", "أ", 1);
      await addUnitBarcodeAlias(1, "3330000000002", "ب", 1);
      // ننقلها من id=1 (قطعة القلم الأزرق) إلى id=2 (درزن القلم الأزرق) — محاكاة نقل بعد إعادة تسمية.
      const moved = await migrateAliases(db(), 1, 2);
      expect(moved).toBe(2);
      const src = await listUnitBarcodes(1);
      const dst = await listUnitBarcodes(2);
      expect(src.aliases).toHaveLength(0);
      expect(dst.aliases).toHaveLength(2);
    });
  });

  describe("A8: createProduct يُدرج البدائل ذرّياً مع المنتج", () => {
    it("createProduct مع barcodeAliases يُدرج الأساسيّ والبدائل معاً", async () => {
      const res = await createProduct(
        {
          name: "قلم جاف أزرق شكل ٢",
          variants: [
            {
              sku: "PEN-BLU-S2",
              costPrice: "150.00",
              units: [
                {
                  unitName: "قطعة",
                  conversionFactor: "1",
                  barcode: "1110000000001",
                  isBaseUnit: true,
                  prices: [{ priceTier: "RETAIL", price: "500.00" }],
                  barcodeAliases: [
                    { barcode: "2220000000002", note: "شكل ٢" },
                    { barcode: "3330000000003", note: "شكل ٣" },
                  ],
                },
              ],
            },
          ],
        },
        { userId: 1, branchId: 1 },
      );
      expect(res.productId).toBeGreaterThan(0);
      // كل الباركودات الثلاثة تحلّ لنفس المنتج/الوحدة
      const primary = await resolveBarcodeOwner(db(), "1110000000001");
      const alias1 = await resolveBarcodeOwner(db(), "2220000000002");
      const alias2 = await resolveBarcodeOwner(db(), "3330000000003");
      expect(primary?.productUnitId).toBe(alias1?.productUnitId);
      expect(primary?.productUnitId).toBe(alias2?.productUnitId);
      expect(primary?.productName).toBe("قلم جاف أزرق شكل ٢");
    });

    it("createProduct مع بديل يطابق باركوداً موجوداً ⇒ CONFLICT (تفرّد قبل الإدراج)", async () => {
      // "6001000000017" هو أساسيّ للقلم الأزرق (id=1) من seedBase.
      await expect(
        createProduct(
          {
            name: "منتج جديد",
            variants: [
              {
                sku: "NEW-1",
                costPrice: "100.00",
                units: [
                  {
                    unitName: "قطعة",
                    conversionFactor: "1",
                    barcode: "9999999999999",
                    isBaseUnit: true,
                    prices: [{ priceTier: "RETAIL", price: "200.00" }],
                    barcodeAliases: [{ barcode: "6001000000017", note: "تعارض" }],
                  },
                ],
              },
            ],
          },
          { userId: 1, branchId: 1 },
        ),
      ).rejects.toThrow(/مُستخدَم|CONFLICT/);
    });

    it("createProduct يرفض تكرار بديلين متطابقين داخل نفس الحمولة", async () => {
      await expect(
        createProduct(
          {
            name: "منتج ٣",
            variants: [
              {
                sku: "P3",
                costPrice: "50.00",
                units: [
                  {
                    unitName: "قطعة",
                    conversionFactor: "1",
                    barcode: "8880000000001",
                    isBaseUnit: true,
                    prices: [{ priceTier: "RETAIL", price: "80.00" }],
                    barcodeAliases: [
                      { barcode: "7770000000001", note: "أ" },
                      { barcode: "7770000000001", note: "مكرَّر" },
                    ],
                  },
                ],
              },
            ],
          },
          { userId: 1, branchId: 1 },
        ),
      ).rejects.toThrow(/مكرّر|CONFLICT/);
    });
  });

  describe("A7: findBarcodeClashes يحترم استثناءات المفاتيح", () => {
    it("يتجاهل الوحدة الحاليّة في الاستثناء (تحديث ذاتيّ)", async () => {
      const clashes = await findBarcodeClashes(db(), ["6001000000017"], {
        ignorePrimaryUnitIds: [1],
      });
      expect(clashes).toHaveLength(0);
    });
    it("لا يتجاهل وحدة أخرى — تُبقى كصدام", async () => {
      const clashes = await findBarcodeClashes(db(), ["6001000000017"]);
      expect(clashes).toHaveLength(1);
      expect(clashes[0].source).toBe("primary");
    });
  });

  describe("A8 (٤/٩): التطبيع — الحفظ نظيفٌ دائماً، والمطابقة تتسامح مع الإرث الملوَّث", () => {
    // الجذر: مخطّطات الحفظ كانت بلا `.trim()` والإدراج يكتب المُدخل خاماً، بينما المطابقة مساواةٌ SQL
    // خامّة ⇒ «10095 » بمسافةٍ يُحفَظ ويمرّ فحصَ التفرّد (الذي كان يقلّم للفحص وحده) ثمّ لا يُمسَح أبداً.
    // الكتابة الخامّة هنا (update/insert مباشر) تحاكي صفّاً إرثياً حُفظ قبل التطبيع.
    it("resolveBarcodeOwner يحلّ أساسياً مخزَّناً بمسافةٍ طرفية وبديلاً مخزَّناً بأرقامٍ عربية-هندية", async () => {
      const d = db();
      await d.update(s.productUnits).set({ barcode: " 10095 " }).where(eq(s.productUnits.id, 3));
      await d.insert(s.productUnitBarcodes).values({ productUnitId: 1, barcode: "٩٩٩٠٠٠٠٠٠٠٠٤٤" });
      expect(await resolveBarcodeOwner(d, "10095")).toMatchObject({ productUnitId: 3, matchKind: "PRIMARY" });
      expect(await resolveBarcodeOwner(d, "9990000000044")).toMatchObject({ productUnitId: 1, matchKind: "ALIAS" });
      // ومُدخلٌ بأرقامٍ عربية على باركودٍ نظيف يُطبَّع قبل المطابقة (لوحة مفاتيح عربية على الحقل اليدويّ).
      expect(await resolveBarcodeOwner(d, "٦٠٠١٠٠٠٠٠٠٠١٧")).toMatchObject({ productUnitId: 1, matchKind: "PRIMARY" });
      // الكاشير (POS) والكشك يمرّان بالحلّال نفسه ⇒ يريان الصفّ الإرثيّ أيضاً بلا هجرة بيانات.
      expect(await lookupByBarcode("10095", 1, "RETAIL")).toMatchObject({ productUnitId: 3 });
      expect(await kioskLookup("9990000000044", 1)).toMatchObject({ productName: "قلم أزرق" });
    });

    it("يشفي إرثاً ملوَّثاً بتبويب/سطرٍ جديد/مسافةٍ غير قابلة للكسر (لا مسافة ASCII وحدها)", async () => {
      // مراجعة عدائية ٤/٩: SQL `TRIM()` بلا وسيط يقلّم 0x20 فقط، بينما `canonicalizeBarcodeInput`
      // يقلّم كلّ فراغات JS `.trim()` (\t \n \r NBSP) — وهي لاحقةُ Excel/الماسح الشائعة. لولا التكافؤ
      // لبقيت هذه الفئةُ غيرَ قابلةٍ للمسح رغم أنّ الإصلاح صرّح بها مصدراً للجذر.
      const d = db();
      await d.update(s.productUnits).set({ barcode: "6001000000017\t" }).where(eq(s.productUnits.id, 1));
      await d.update(s.productUnits).set({ barcode: " 6001000000024" }).where(eq(s.productUnits.id, 2)); // NBSP سابقة
      await d.insert(s.productUnitBarcodes).values({ productUnitId: 3, barcode: "7770000000001\r\n" });
      expect(await resolveBarcodeOwner(d, "6001000000017")).toMatchObject({ productUnitId: 1, matchKind: "PRIMARY" });
      expect(await resolveBarcodeOwner(d, "6001000000024")).toMatchObject({ productUnitId: 2, matchKind: "PRIMARY" });
      expect(await resolveBarcodeOwner(d, "7770000000001")).toMatchObject({ productUnitId: 3, matchKind: "ALIAS" });
      // وكشفُ الصدام يراه: باركودٌ نظيف يساوي مخزَّناً بتبويبٍ على سلعةٍ أخرى ⇒ صدام (لا حفظٌ صامتٌ مزدوج).
      expect(await findBarcodeClashes(d, ["6001000000017"])).toHaveLength(1);
    });

    it("المسار الاحتياطيّ يرفض الحسم عند تعدّد المالك (لا يُسعّر المسحَ لغير صاحبه)", async () => {
      // مراجعة عدائية ٤/٩ (سلامة مالية): لو تطبّع صفّان ملوّثان على وحدتين مختلفتين إلى القيمة نفسها،
      // فإعادةُ أدنى id صامتاً تُسعّر المسحَ لغير صاحبه. المطلوب: null ⇒ رسالةُ «لا يطابق» فيبحث الكاشير يدوياً.
      const d = db();
      await d.update(s.productUnits).set({ barcode: " 55500 " }).where(eq(s.productUnits.id, 1)); // وحدة القلم الأزرق
      await d.update(s.productUnits).set({ barcode: "55500\t" }).where(eq(s.productUnits.id, 3)); // وحدة القلم الأحمر
      // كلاهما ملوَّثٌ فيُخفق المسارُ السريع، والاحتياطيّ يجد مالكَين متمايزين ⇒ لا حسم.
      expect(await resolveBarcodeOwner(d, "55500")).toBeNull();
      // وحين يبقى مالكٌ واحدٌ ملوَّث (نُظّف الآخر إلى قيمةٍ مختلفة) ⇒ يُحسَم لصاحبه الوحيد.
      await d.update(s.productUnits).set({ barcode: "55501" }).where(eq(s.productUnits.id, 3));
      expect(await resolveBarcodeOwner(d, "55500")).toMatchObject({ productUnitId: 1, matchKind: "PRIMARY" });
    });

    it("الغموض يُكشَف ولو كان مالكٌ يحمل صفَّي بديلٍ ملوّثين (عدُّ المُلّاك لا الصفوف — Codex P1)", async () => {
      // الحالة التي كان يفوتها حدُّ الصفوف (limit 2): وحدةٌ (1) لها بديلان ملوّثان يتطبّعان لنفس القيمة،
      // ووحدةٌ أخرى (3) لها بديلٌ ثالثٌ يتطبّع لها أيضاً. حدُّ صفَّين يلتقط بديلَي الوحدة 1 فقط فيحسم لها
      // خطأً؛ عدُّ المُلّاك المتمايزين (groupBy) يرى وحدتين ⇒ غموضٌ ⇒ null.
      //
      // ⚠️ نستعمل تلويثاً بمسافةٍ بادئة/تبويب/سطرٍ جديد (لا أرقاماً عربيةً ولا مسافةً لاحقةً وحدها):
      // ترتيبُ حروف القاعدة `utf8mb4_unicode_ci` يطوي الأرقام العربية↔اللاتينية ويتجاهل المسافة
      // اللاحقة في `=` (وفي قيد UNIQUE)، فباركودٌ بأرقامٍ عربية أو مسافةٍ لاحقةٍ **يطابقه المسارُ السريع
      // نفسه** (وهو الصحيح: مالكٌ فعليّ). التلويثُ الذي يفلت من `=` ومن UNIQUE معاً هو ما يبلغ الاحتياطيّ.
      const d = db();
      await d.insert(s.productUnitBarcodes).values([
        { productUnitId: 1, barcode: " 88800" }, // مسافة بادئة ⇒ يفلت من = (وحدة 1)
        { productUnitId: 1, barcode: "88800\t" }, // تبويب ⇒ يفلت من = (نفس الوحدة 1)
        { productUnitId: 3, barcode: "88800\n" }, // سطرٌ جديد ⇒ يفلت من = (وحدة 3 مختلفة)
      ]);
      expect(await resolveBarcodeOwner(d, "88800")).toBeNull();
      // إزالة صفّ الوحدة 3 يُبقي مالكاً واحداً (الوحدة 1) ⇒ يُحسَم لها.
      await d.delete(s.productUnitBarcodes).where(and(eq(s.productUnitBarcodes.productUnitId, 3), eq(s.productUnitBarcodes.barcode, "88800\n")));
      expect(await resolveBarcodeOwner(d, "88800")).toMatchObject({ productUnitId: 1, matchKind: "ALIAS" });
    });

    it("المسار السريع أوّلاً: الصفّ النظيف يفوز على الإرث الملوَّث المكافئ له", async () => {
      // نظيفٌ على الوحدة ١ وملوَّثٌ مكافئ على الوحدة ٣ — المساواة الخامّة (المُفهرَسة) تُرجع النظيف
      // قبل أن يُدفَع ثمنُ المسار الاحتياطيّ، فلا يتبدّل مالك الباركود بين مسحٍ وآخر.
      const d = db();
      await d.update(s.productUnits).set({ barcode: "10095" }).where(eq(s.productUnits.id, 1));
      await d.update(s.productUnits).set({ barcode: " 10095 " }).where(eq(s.productUnits.id, 3));
      expect(await resolveBarcodeOwner(d, "10095")).toMatchObject({ productUnitId: 1, matchKind: "PRIMARY" });
    });

    it("الحفظ يُطبّع: assignBarcode/addUnitBarcodeAlias/createProduct تخزّن القيمة مقلَّمةً ومطويّة الأرقام", async () => {
      const d = db();
      await assignBarcode(2, "  6001000000099 ");
      expect((await d.select({ b: s.productUnits.barcode }).from(s.productUnits).where(eq(s.productUnits.id, 2)))[0]?.b).toBe("6001000000099");
      await addUnitBarcodeAlias(1, " ٩٩٩٠٠٠٠٠٠٠٠٥٧ ", null, 1);
      expect((await listUnitBarcodes(1)).aliases.map((a) => a.barcode)).toContain("9990000000057");
      await createProduct(
        {
          name: "منتج بمسافةٍ في باركوده",
          variants: [
            {
              sku: "SP-1",
              costPrice: "1.00",
              units: [
                {
                  unitName: "قطعة",
                  conversionFactor: "1",
                  barcode: " 1110000000088 ",
                  isBaseUnit: true,
                  prices: [{ priceTier: "RETAIL", price: "500.00" }],
                  barcodeAliases: [{ barcode: " ١١١٠٠٠٠٠٠٠٠٩٥ " }],
                },
              ],
            },
          ],
        },
        { userId: 1, branchId: 1 },
      );
      // المُخزَّن نظيف ⇒ المسار السريع (المُفهرَس) يجده، لا الاحتياطيّ.
      expect(await resolveBarcodeOwner(d, "1110000000088")).toMatchObject({ matchKind: "PRIMARY", primaryBarcode: "1110000000088" });
      expect(await resolveBarcodeOwner(d, "1110000000095")).toMatchObject({ matchKind: "ALIAS", primaryBarcode: "1110000000088" });
    });

    it("كشف الصدام يرى الإرث الملوَّث: باركودٌ نظيف يساوي مخزَّناً بمسافةٍ على سلعةٍ أخرى ⇒ صدام", async () => {
      const d = db();
      await d.update(s.productUnits).set({ barcode: " 10095 " }).where(eq(s.productUnits.id, 3));
      const clashes = await findBarcodeClashes(d, ["10095"]);
      expect(clashes).toHaveLength(1);
      expect(clashes[0]).toMatchObject({ source: "primary", code: " 10095 " });
      await expect(assignBarcode(1, "10095")).rejects.toThrow(/مُستخدَم|CONFLICT/);
      expect(await checkBarcodesTakenAcrossBoth(["١٠٠٩٥"])).toHaveLength(1);
      // والتحديث الذاتيّ لا يصطدم بنفسه.
      expect(await findBarcodeClashes(d, ["10095"], { ignorePrimaryUnitIds: [3] })).toHaveLength(0);
    });
  });
});
