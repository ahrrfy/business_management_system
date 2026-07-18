// لقطات الكتالوج/المخزون/العملاء للعمل دون اتصال — الشريحة ٢ من خطة الأوفلاين.
//
// قرار التصميم (بدل دلتا معقدة): «نسخة كتالوج» رخيصة الحساب تُقارَن عند كل مزامنة، وعند
// تغيّرها يجلب العميل اللقطة الكاملة (مضغوطة gzip — compression() مفعَّلة في server/index.ts).
// السبب: `productUnits`/`productUnitBarcodes` بلا updatedAt أصلاً، والحذف الفعلي (أسعار/بدائل)
// غير مرئي لدلتا updatedAt — بينما تغييرات الكتالوج نادرة يومياً فالجلب الكامل عند التغيّر
// أبسط وأصحّ حتماً. المخزون يتغيّر مع كل بيع ⇒ لقطة مخزون منفصلة صغيرة تُجلب في كل مزامنة
// بلا بوّابة نسخة.
//
// النسخة = بصمة محتوى: count + SUM(CRC32) على الحقول المُصدَّرة بالضبط لكل جدول — تتغيّر
// إذا-وفقط-إذا تغيّر ما يصل العميل (تفصيل المبدأ فوق catalogVersionParts أدناه).

import { and, eq, sql } from "drizzle-orm";
import {
  branchStock,
  customers,
  productPrices,
  products,
  productUnitBarcodes,
  productUnits,
  productVariants,
} from "../../../drizzle/schema";
import type {
  OfflineCatalogRow,
  OfflineCatalogSnapshot,
  OfflineCustomersSnapshot,
  OfflinePriceTier,
  OfflineStockRow,
  OfflineVersions,
} from "@shared/offlineCatalog";
import { normalizeSearchText } from "@shared/searchNormalize";
import { TRPCError } from "@trpc/server";
import { getDb } from "../../db";
import { PRINT_SERVICE_TYPE } from "../printSaleService";

function requireDbOrThrow() {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  return db;
}

// مبدأ النسخة: بصمة محتوى (count + SUM(CRC32) على **الحقول المُصدَّرة بالضبط** في اللقطة) —
// لا اعتماد على updatedAt إطلاقاً (دقّته ثانية واحدة، وتعديلٌ في نفس ثانية الإدراج يفلت منه؛
// وproductUnits/البدائل بلا updatedAt أصلاً). النتيجة: النسخة تتغيّر إذا-وفقط-إذا تغيّر ما
// يصل العميل فعلاً.
async function catalogVersionParts(db: NonNullable<ReturnType<typeof getDb>>): Promise<string> {
  const [prod] = await db
    .select({
      cnt: sql<number>`count(*)`,
      crc: sql<string>`coalesce(sum(crc32(concat_ws('|', ${products.id}, ${products.name}, ${products.isActive}, ${products.isService}, ${products.isCustomizable}, ${products.isBundle}, coalesce(${products.productType}, '')))), 0)`,
    })
    .from(products);
  const [vars] = await db
    .select({
      cnt: sql<number>`count(*)`,
      crc: sql<string>`coalesce(sum(crc32(concat_ws('|', ${productVariants.id}, ${productVariants.productId}, coalesce(${productVariants.variantName}, ''), coalesce(${productVariants.color}, ''), coalesce(${productVariants.colorHex}, ''), coalesce(${productVariants.size}, ''), ${productVariants.sku}, ${productVariants.isActive}))), 0)`,
    })
    .from(productVariants);
  const [prices] = await db
    .select({
      cnt: sql<number>`count(*)`,
      crc: sql<string>`coalesce(sum(crc32(concat_ws('|', ${productPrices.productUnitId}, ${productPrices.priceTier}, ${productPrices.price}))), 0)`,
    })
    .from(productPrices);
  const [units] = await db
    .select({
      cnt: sql<number>`count(*)`,
      crc: sql<string>`coalesce(sum(crc32(concat_ws('|', ${productUnits.id}, ${productUnits.unitName}, ${productUnits.conversionFactor}, coalesce(${productUnits.barcode}, ''), ${productUnits.isBaseUnit}, ${productUnits.isActive}))), 0)`,
    })
    .from(productUnits);
  const [aliases] = await db
    .select({
      cnt: sql<number>`count(*)`,
      crc: sql<string>`coalesce(sum(crc32(concat_ws('|', ${productUnitBarcodes.productUnitId}, ${productUnitBarcodes.barcode}))), 0)`,
    })
    .from(productUnitBarcodes);
  return [
    // بادئة نسخة الاشتقاق: تُرفَع يدوياً عند أي تغيير في **صيغة** اللقطة (حقول/searchText…)
    // — بصمة الـCRC تلتقط تغيّر البيانات فقط، لا تغيّر الكود المُشتِق. v2: الباركودات في searchText.
    "v2",
    prod.cnt, prod.crc,
    vars.cnt, vars.crc,
    prices.cnt, prices.crc,
    units.cnt, units.crc,
    aliases.cnt, aliases.crc,
  ].join("|");
}

async function customersVersionPart(db: NonNullable<ReturnType<typeof getDb>>): Promise<string> {
  const [c] = await db
    .select({
      cnt: sql<number>`count(*)`,
      crc: sql<string>`coalesce(sum(crc32(concat_ws('|', ${customers.id}, ${customers.name}, coalesce(${customers.phone}, ''), coalesce(${customers.defaultPriceTier}, ''), ${customers.isActive}))), 0)`,
    })
    .from(customers);
  return ["v1", c.cnt, c.crc].join("|");
}

export async function buildOfflineVersions(): Promise<OfflineVersions> {
  const db = requireDbOrThrow();
  const [catalogVersion, customersVersion] = await Promise.all([
    catalogVersionParts(db),
    customersVersionPart(db),
  ]);
  return { catalogVersion, customersVersion };
}

/** ظهور الكاشير: منتج/لون/وحدة نشطة كلها. خدمات الطباعة والاستنساخ تُضمَّن بوسمها
 *  (`isPrintService`) والعميل يعرضها حسب وضع الشاشة — نفس فلسفة `posVisibility`.
 *  الكتالوج والأسعار مشتركة على مستوى الشركة (مثل posList) — المحجوب فرعياً هو المخزون
 *  فقط وله لقطته المنفصلة `buildStockSnapshot`. */
export async function buildCatalogSnapshot(): Promise<OfflineCatalogSnapshot> {
  const db = requireDbOrThrow();

  const [version, base, priceRows, aliasRows] = await Promise.all([
    catalogVersionParts(db),
    db
      .select({
        productUnitId: productUnits.id,
        productId: products.id,
        productName: products.name,
        variantId: productVariants.id,
        variantName: productVariants.variantName,
        color: productVariants.color,
        colorHex: productVariants.colorHex,
        size: productVariants.size,
        sku: productVariants.sku,
        unitName: productUnits.unitName,
        conversionFactor: productUnits.conversionFactor,
        barcode: productUnits.barcode,
        isBaseUnit: productUnits.isBaseUnit,
        isService: products.isService,
        isCustomizable: products.isCustomizable,
        isBundle: products.isBundle,
        productType: products.productType,
      })
      .from(productUnits)
      .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(products.isActive, true),
          eq(productVariants.isActive, true),
          eq(productUnits.isActive, true),
        ),
      ),
    db
      .select({
        productUnitId: productPrices.productUnitId,
        priceTier: productPrices.priceTier,
        price: productPrices.price,
      })
      .from(productPrices),
    db
      .select({
        productUnitId: productUnitBarcodes.productUnitId,
        barcode: productUnitBarcodes.barcode,
      })
      .from(productUnitBarcodes),
  ]);

  const pricesByUnit = new Map<number, Partial<Record<OfflinePriceTier, string>>>();
  for (const p of priceRows) {
    const unitId = Number(p.productUnitId);
    const entry = pricesByUnit.get(unitId) ?? {};
    entry[p.priceTier as OfflinePriceTier] = String(p.price);
    pricesByUnit.set(unitId, entry);
  }

  const aliasesByUnit = new Map<number, string[]>();
  for (const a of aliasRows) {
    const unitId = Number(a.productUnitId);
    const list = aliasesByUnit.get(unitId) ?? [];
    list.push(a.barcode);
    aliasesByUnit.set(unitId, list);
  }

  const rows: OfflineCatalogRow[] = base.map((r) => {
    const unitId = Number(r.productUnitId);
    const prices = pricesByUnit.get(unitId) ?? {};
    const aliases = aliasesByUnit.get(unitId) ?? [];
    const allBarcodes = [r.barcode, ...aliases].filter((b): b is string => !!b);
    return {
      productUnitId: unitId,
      productId: Number(r.productId),
      productName: r.productName,
      variantId: Number(r.variantId),
      variantName: r.variantName,
      color: r.color,
      colorHex: r.colorHex,
      size: r.size,
      sku: r.sku,
      unitName: r.unitName,
      conversionFactor: String(r.conversionFactor),
      barcode: r.barcode,
      allBarcodes,
      isBaseUnit: !!r.isBaseUnit,
      isService: !!r.isService,
      isBundle: !!r.isBundle,
      isCustomizable: !!r.isCustomizable,
      isPrintService: r.productType === PRINT_SERVICE_TYPE,
      priceRetail: prices.RETAIL ?? null,
      priceWholesale: prices.WHOLESALE ?? null,
      priceGovernment: prices.GOVERNMENT ?? null,
      // الباركودات ضمن نص البحث — تكافؤ مع بحث الخادم الذي يطابق productUnits.barcode
      // (كتابة الباركود يدوياً في حقل البحث تجده حتى بلا توقيت ماسح HID).
      searchText: normalizeSearchText(
        [r.productName, r.variantName, r.color, r.size, r.sku, r.unitName, ...allBarcodes]
          .filter(Boolean)
          .join(" "),
      ),
    };
  });

  return { version, generatedAt: new Date().toISOString(), rows };
}

export async function buildStockSnapshot(branchId: number): Promise<OfflineStockRow[]> {
  const db = requireDbOrThrow();
  const rows = await db
    .select({ variantId: branchStock.variantId, qty: branchStock.quantity })
    .from(branchStock)
    .where(eq(branchStock.branchId, branchId));
  return rows.map((r) => ({ variantId: Number(r.variantId), qty: Number(r.qty) }));
}

export async function buildCustomersSnapshot(): Promise<OfflineCustomersSnapshot> {
  const db = requireDbOrThrow();
  const [version, rows] = await Promise.all([
    customersVersionPart(db),
    db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        defaultPriceTier: customers.defaultPriceTier,
      })
      .from(customers)
      .where(eq(customers.isActive, true)),
  ]);
  return {
    version,
    rows: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      phone: r.phone,
      defaultPriceTier: (r.defaultPriceTier as OfflinePriceTier | null) ?? null,
      searchText: normalizeSearchText([r.name, r.phone].filter(Boolean).join(" ")),
    })),
  };
}
