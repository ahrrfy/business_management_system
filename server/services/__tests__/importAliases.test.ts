// اختبارات ذهاب-إياب بدائل الباركود في استيراد المنتجات (عمود «بدائل الباركود»).
// الثوابت:
//   R1: منتج جديد ببدائل ⇒ تُنشأ البدائل مع وحدتها الصحيحة (وتقبل «،» و«,» فاصلَين).
//   R2: فضاء تفرّد واحد داخل الملف (أساسيّ + بديل) — التكرار يُفشل الصفوف المالكة.
//   R3: البديل المطابق للأساسيّ نفسه = خطأ صفّي واضح.
//   R4: إعادة استيراد الملف نفسه لا-عملية (idempotent): تخطٍّ بلا تكرار بدائل.
//   R5: بديل جديد على منتج موجود ⇒ دمج إضافي (updated) بلا مسّ البدائل القائمة.
//   R6: بديل مستعمل لسلعة أخرى في القاعدة (أساسياً أو بديلاً) ⇒ فشل بلا كتابة.
//   R7: dryRun يعاين الدمج (updated) بلا أي كتابة.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { importProducts, type ProductImportRow } from "../importService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "importBatches",
  "productUnitBarcodes",
  "inventoryMovements",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "categories",
  "branches",
  "users",
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

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
}

const row = (over: Partial<ProductImportRow> & { rowNumber: number }): ProductImportRow => ({
  productName: "قلم",
  sku: "PEN-1",
  costPrice: "1.00",
  unitName: "قطعة",
  conversionFactor: "1",
  isBaseUnit: true,
  retailPrice: "2.00",
  ...over,
});

async function allAliases() {
  return db()
    .select({ unitId: s.productUnitBarcodes.productUnitId, barcode: s.productUnitBarcodes.barcode })
    .from(s.productUnitBarcodes);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("importProducts — بدائل الباركود (ذهاب-إياب)", () => {
  it("R1: منتج جديد ببدائل (فاصلة عربية ولاتينية) ⇒ تُنشأ مع وحدتها الصحيحة", async () => {
    const r = await importProducts(
      [
        row({ rowNumber: 1, barcode: "1000000000001", barcodeAliases: "2000000000001، 2000000000002" }),
        row({ rowNumber: 2, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "1000000000002", barcodeAliases: "2000000000003,2000000000004" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect(r.created).toBe(2);
    const units = await db().select().from(s.productUnits);
    const piece = units.find((u) => u.unitName === "قطعة")!;
    const dozen = units.find((u) => u.unitName === "درزن")!;
    const aliases = await allAliases();
    expect(aliases.filter((a) => Number(a.unitId) === Number(piece.id)).map((a) => a.barcode).sort()).toEqual([
      "2000000000001",
      "2000000000002",
    ]);
    expect(aliases.filter((a) => Number(a.unitId) === Number(dozen.id)).map((a) => a.barcode).sort()).toEqual([
      "2000000000003",
      "2000000000004",
    ]);
  });

  it("R2: البديل المكرّر مع باركود أساسيّ لسلعة أخرى في الملف يُفشل الصفوف (فضاء واحد)", async () => {
    const r = await importProducts(
      [
        row({ rowNumber: 1, barcode: "3000000000001" }),
        row({ rowNumber: 2, productName: "دفتر", sku: "NB-1", barcode: "3000000000002", barcodeAliases: "3000000000001" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.failed).toBe(2);
    expect(await allAliases()).toHaveLength(0);
  });

  it("R3: البديل المطابق للباركود الأساسيّ لنفس الوحدة = خطأ صفّي واضح", async () => {
    const r = await importProducts(
      [row({ rowNumber: 1, barcode: "4000000000001", barcodeAliases: "4000000000001" })],
      {},
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.failed).toBe(1);
    expect(r.rows[0].message).toContain("يطابق الباركود الأساسي");
  });

  it("R4: إعادة استيراد الملف نفسه لا-عملية: تخطٍّ بلا تكرار بدائل", async () => {
    const rows = [row({ rowNumber: 1, barcode: "5000000000001", barcodeAliases: "5100000000001" })];
    const r1 = await importProducts(rows, {}, actor);
    expect(r1.created).toBe(1);
    const r2 = await importProducts(rows, {}, actor);
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(await allAliases()).toHaveLength(1);
  });

  it("R5: بديل جديد على منتج موجود ⇒ دمج إضافي (updated) بلا مسّ القائم", async () => {
    await importProducts([row({ rowNumber: 1, barcode: "6000000000001", barcodeAliases: "6100000000001" })], {}, actor);
    // إعادة استيراد بعمود بدائل موسَّع (القائم + جديد) — نمط «تصدير ← إضافة في Excel ← استيراد».
    const r = await importProducts(
      [row({ rowNumber: 1, barcode: "6000000000001", barcodeAliases: "6100000000001، 6200000000002" })],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect(r.updated).toBe(1);
    expect(r.rows[0].message).toContain("أُضيفت بدائل");
    const aliases = (await allAliases()).map((a) => a.barcode).sort();
    expect(aliases).toEqual(["6100000000001", "6200000000002"]);
  });

  it("R6: بديل مستعمل لسلعة أخرى في القاعدة ⇒ فشل بلا كتابة", async () => {
    await importProducts([row({ rowNumber: 1, productName: "الأصل", sku: "OWN-1", barcode: "7000000000001" })], {}, actor);
    await importProducts([row({ rowNumber: 1, barcode: "7000000000002" })], {}, actor); // «قلم» PEN-1 موجود
    const before = await allAliases();
    // على الموجود: بديل يطابق الباركود الأساسيّ لمنتج آخر ⇒ فشل صفوف المتغيّر بلا أي إدراج.
    const r = await importProducts(
      [row({ rowNumber: 1, barcode: "7000000000002", barcodeAliases: "7000000000001" })],
      {},
      actor,
    );
    expect(r.failed).toBe(1);
    expect(r.rows[0].message).toContain("مستعمل مسبقاً");
    expect(await allAliases()).toEqual(before);
  });

  it("R7: dryRun يعاين الدمج (updated) بلا أي كتابة", async () => {
    await importProducts([row({ rowNumber: 1, barcode: "8000000000001" })], {}, actor);
    const r = await importProducts(
      [row({ rowNumber: 1, barcode: "8000000000001", barcodeAliases: "8100000000001" })],
      { dryRun: true },
      actor,
    );
    expect(r.committed).toBe(false);
    expect(r.updated).toBe(1);
    expect(await allAliases()).toHaveLength(0);
  });

  it("R5ب: منتج موجود بوحدتين — بدائل على وحدة غير الأساس تُدمَج على الوحدة الصحيحة", async () => {
    const twoUnits = [
      row({ rowNumber: 1, barcode: "9000000000001" }),
      row({ rowNumber: 2, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "9000000000002" }),
    ];
    await importProducts(twoUnits, {}, actor);
    const r = await importProducts(
      [
        twoUnits[0],
        row({ rowNumber: 2, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "9000000000002", barcodeAliases: "9100000000001" }),
      ],
      {},
      actor,
    );
    expect(r.committed).toBe(true);
    expect(r.updated).toBe(2); // صفّا المتغيّر نفسه يترقّيان معاً
    const dozen = (await db().select().from(s.productUnits).where(eq(s.productUnits.unitName, "درزن")))[0];
    const aliases = await allAliases();
    expect(aliases).toHaveLength(1);
    expect(Number(aliases[0].unitId)).toBe(Number(dozen.id));
    expect(aliases[0].barcode).toBe("9100000000001");
  });
});
