// اختبارات باركودات بديلة (aliases) — نفس السلعة/التكلفة/السعر/المخزون بعدّة باركودات.
// تُغطّي ثوابت السلامة الثلاثة الأساسية:
//   A1: الأساسيّ + البديل يشيران للوحدة نفسها ⇒ lookupByBarcode يحلّ الاثنين إلى POS row واحد.
//   A2: تفرّد عالميّ — باركود موجود كأساسيّ لسلعة أخرى، أو بديلاً لسلعة أخرى، يُرفض عند الإضافة كبديل.
//   A3: حذف الوحدة يحذف بدائلها بـcascade (بلا orphan aliases).
import { eq } from "drizzle-orm";
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
      // حذف productUnits.id=1 مباشرةً — يجب أن تختفي البدائل تلقائياً.
      await db().delete(s.productUnits).where(eq(s.productUnits.id, 1));
      const orphans = await db()
        .select({ id: s.productUnitBarcodes.id })
        .from(s.productUnitBarcodes)
        .where(eq(s.productUnitBarcodes.productUnitId, 1));
      expect(orphans).toHaveLength(0);
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
});
