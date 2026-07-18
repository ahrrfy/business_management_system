// اختبارات لقطات العمل دون اتصال (الشريحة ٢) — الكتالوج/المخزون/العملاء + دلالة النسخ.
// تعمل على قاعدة الاختبار الحقيقية: جوهر النسخة SUM(CRC32) يُنفَّذ في SQL.
import { normalizeSearchText } from "@shared/searchNormalize";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  buildCatalogSnapshot,
  buildCustomersSnapshot,
  buildOfflineVersions,
  buildStockSnapshot,
} from "../offline/catalogSnapshot";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["branchStock", "productUnitBarcodes", "productPrices", "productUnits", "productVariants", "products", "customers", "branches"]) {
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
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف أزرق" },
    { id: 2, name: "منتج معطَّل", isActive: false },
    { id: 3, name: "خدمة تغليف", isService: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-BLUE", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "OFF-1", costPrice: "0.00" },
    { id: 3, productId: 3, sku: "SRV-WRAP", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "1000000000017" },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "1000000000024" },
    { id: 3, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 3, unitName: "خدمة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "500.00" },
    { productUnitId: 1, priceTier: "WHOLESALE", price: "400.00" },
    // درزن: سعر مفرد فقط — فئة الجملة غائبة عمداً (يجب أن تصل null لا fallback).
    { productUnitId: 2, priceTier: "RETAIL", price: "5500.00" },
    { productUnitId: 4, priceTier: "RETAIL", price: "1000.00" },
  ]);
  await d.insert(s.productUnitBarcodes).values([
    { productUnitId: 1, barcode: "ALIAS-111" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 36 },
    { variantId: 1, branchId: 2, quantity: 7 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "شركة أوائل المعرفة", phone: "07701234567", defaultPriceTier: "WHOLESALE" },
    { id: 2, name: "عميل معطَّل", isActive: false },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

describe("buildCatalogSnapshot — لقطة الكتالوج المسطّحة", () => {
  it("تُصدّر النشط فقط، صفاً لكل وحدة، بأسعار الفئات الثلاث بلا fallback", async () => {
    const snap = await buildCatalogSnapshot();
    // منتج معطَّل (id=2) لا يظهر؛ النشطان: قلم (وحدتان) + خدمة (وحدة) = ٣ صفوف.
    expect(snap.rows).toHaveLength(3);
    const piece = snap.rows.find((r) => r.productUnitId === 1)!;
    expect(piece.priceRetail).toBe("500.00");
    expect(piece.priceWholesale).toBe("400.00");
    expect(piece.priceGovernment).toBeNull();
    const dozen = snap.rows.find((r) => r.productUnitId === 2)!;
    expect(dozen.priceRetail).toBe("5500.00");
    expect(dozen.priceWholesale).toBeNull(); // لا fallback من المفرد
    // نصّ العمود decimal كما هو (scale=4) — نفس ما يصل POS أونلاين، التكافؤ مقصود.
    expect(dozen.conversionFactor).toBe("12.0000");
    expect(dozen.isBaseUnit).toBe(false);
  });

  it("allBarcodes تجمع الأساسي والبدائل في فضاء مسح واحد", async () => {
    const snap = await buildCatalogSnapshot();
    const piece = snap.rows.find((r) => r.productUnitId === 1)!;
    expect(piece.allBarcodes).toEqual(expect.arrayContaining(["1000000000017", "ALIAS-111"]));
    expect(piece.allBarcodes).toHaveLength(2);
  });

  it("searchText مُطبَّع عربياً: «ازرق» بلا همزة يطابق «أزرق»", async () => {
    const snap = await buildCatalogSnapshot();
    const piece = snap.rows.find((r) => r.productUnitId === 1)!;
    expect(piece.searchText).toContain("ازرق");
  });

  it("searchText يشمل الباركودات (الأساسي والبديل) — تكافؤ بحث الخادم النصي بالباركود", async () => {
    const snap = await buildCatalogSnapshot();
    const piece = snap.rows.find((r) => r.productUnitId === 1)!;
    expect(piece.searchText).toContain("1000000000017");
    expect(piece.searchText.toLowerCase()).toContain("alias-111");
  });

  it("وسم الخدمة يصل (isService) — أسلم عناصر البيع الأوفلايني", async () => {
    const snap = await buildCatalogSnapshot();
    const svc = snap.rows.find((r) => r.productUnitId === 4)!;
    expect(svc.isService).toBe(true);
  });
});

describe("النسخ — بصمة محتوى تتغيّر إذا-وفقط-إذا تغيّر المُصدَّر", () => {
  it("تعديل سعر (بلا تغيير عدد الصفوف) يغيّر نسخة الكتالوج", async () => {
    const before = await buildOfflineVersions();
    await db().update(s.productPrices)
      .set({ price: "550.00" })
      .where(eq(s.productPrices.productUnitId, 1));
    const after = await buildOfflineVersions();
    expect(after.catalogVersion).not.toBe(before.catalogVersion);
    expect(after.customersVersion).toBe(before.customersVersion);
  });

  it("إعادة تسمية وحدة (جدول بلا updatedAt) يغيّر النسخة — CRC يلتقطها", async () => {
    const before = await buildOfflineVersions();
    await db().update(s.productUnits).set({ unitName: "كرتون" }).where(eq(s.productUnits.id, 2));
    const after = await buildOfflineVersions();
    expect(after.catalogVersion).not.toBe(before.catalogVersion);
  });

  it("إضافة باركود بديل تغيّر النسخة", async () => {
    const before = await buildOfflineVersions();
    await db().insert(s.productUnitBarcodes).values([{ productUnitId: 2, barcode: "ALIAS-222" }]);
    const after = await buildOfflineVersions();
    expect(after.catalogVersion).not.toBe(before.catalogVersion);
  });

  it("حركة مخزون لا تغيّر نسخة الكتالوج (للمخزون لقطته الدورية المنفصلة)", async () => {
    const before = await buildOfflineVersions();
    await db().update(s.branchStock).set({ quantity: 12 }).where(eq(s.branchStock.variantId, 1));
    const after = await buildOfflineVersions();
    expect(after.catalogVersion).toBe(before.catalogVersion);
  });

  it("تعديل عميل يغيّر نسخة العملاء دون نسخة الكتالوج", async () => {
    const before = await buildOfflineVersions();
    await db().update(s.customers).set({ phone: "07709999999" }).where(eq(s.customers.id, 1));
    const after = await buildOfflineVersions();
    expect(after.customersVersion).not.toBe(before.customersVersion);
    expect(after.catalogVersion).toBe(before.catalogVersion);
  });
});

describe("buildStockSnapshot — عزل الفرع", () => {
  it("تُرجع أرصدة الفرع المطلوب فقط", async () => {
    const b1 = await buildStockSnapshot(1);
    const b2 = await buildStockSnapshot(2);
    expect(b1).toEqual([{ variantId: 1, qty: 36 }]);
    expect(b2).toEqual([{ variantId: 1, qty: 7 }]);
  });
});

describe("buildCustomersSnapshot — عملاء نشطون بلا بيانات ذمم", () => {
  it("تستثني المعطَّلين ولا تحمل رصيداً ولا سقف ائتمان", async () => {
    const snap = await buildCustomersSnapshot();
    expect(snap.rows).toHaveLength(1);
    const row = snap.rows[0] as unknown as Record<string, unknown>;
    expect(row.name).toBe("شركة أوائل المعرفة");
    expect(row.defaultPriceTier).toBe("WHOLESALE");
    // ⚠️ عمداً: لا currentBalance ولا creditLimit في لقطة الجهاز (الأوفلاين نقدي فقط).
    expect("currentBalance" in row).toBe(false);
    expect("creditLimit" in row).toBe(false);
  });

  it("searchText يشمل الاسم والهاتف — والمطابقة عبر تطبيع الاستعلام نفسه (كما يفعل العميل)", async () => {
    const snap = await buildCustomersSnapshot();
    // «اوائل» تُطبَّع (ئ→ي) تماماً كما طُبِّع العمود ⇒ المطابقة في فضاء موحَّد.
    expect(snap.rows[0].searchText).toContain(normalizeSearchText("اوائل"));
    expect(snap.rows[0].searchText).toContain("07701234567");
  });
});
