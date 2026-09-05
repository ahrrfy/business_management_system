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

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  branchStock,
  customers,
  productPrices,
  products,
  productUnitBarcodes,
  productUnits,
  productVariants,
} from "../../../drizzle/schema";
import { loadVariantAvailability } from "../catalog/variantAvailability";
import type {
  OfflineCatalogRow,
  OfflineCatalogSnapshot,
  OfflineCustomersSnapshot,
  OfflinePriceTier,
  OfflineStockRow,
  OfflineVersions,
} from "@shared/offlineCatalog";
import { normalizeSearchText } from "@shared/searchNormalize";
import { canonicalizeBarcodeInput } from "@shared/barcodeNormalize";
import { TRPCError } from "@trpc/server";
import { getDb } from "../../db";

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
      crc: sql<string>`coalesce(sum(crc32(concat_ws('|', ${products.id}, ${products.name}, ${products.isActive}, ${products.isService}, ${products.isCustomizable}, ${products.isBundle}, coalesce(${products.productType}, ''), ${products.showInPrintPos}, ${products.allowBackorder}))), 0)`,
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
    // — بصمة الـCRC تلتقط تغيّر البيانات فقط، لا تغيّر الكود المُشتِق.
    // v2: الباركودات في searchText.
    // v3 (٢٤/٨، Codex P2 على PR #755): إضافة `showInPrintPos` إلى CRC — تحوّطاً لأيّ تغييرٍ يدويٍّ
    // لاحق لهذا الحقل (لا واجهة تحرير له اليوم — قد تُضاف لاحقاً). يضمن أن أجهزة الأوفلاين تُحدّث
    // لقطتها فوراً بدل الاعتماد على تغيّر productType الملازم في المهاجرة القائمة.
    // v4 (٣١/٨، هجرة 0318): حقلٌ جديد في صيغة اللقطة (`allowBackorder`) + إدخالُه في الـCRC أعلاه.
    // الاثنان لازمان معاً: البادئة تُجبر كل جهازٍ على سحب الصيغة الجديدة (لقطةٌ قديمة تُرجع
    // `undefined` ⇒ تُقرأ «ليس بالطلب» فيعود «نافذ» بلا اتصال)، والـCRC يجعل **قلبَ الوسم**
    // على منتجٍ قائمٍ يُحدّث الأجهزة فوراً — وبدونه يبقى الجهاز على الحقيقة القديمة بلا نهاية،
    // لأنّ لا عموداً آخر في البصمة يتغيّر مع هذا التبديل وحده.
    // v5 (٤/٩، مراجعة Codex P2): اللقطة صارت تُصدّر الباركود **مُطبَّعاً** (`canonicalizeBarcodeInput`)
    // كي يطابقه مُدخلُ المسح المُطبَّع أوفلاين كما أونلاين. البادئة لازمةٌ لأنّ الـCRC محسوبٌ على العمود
    // الخامّ فلا يتغيّر بتطبيع القيمة المُصدَّرة وحده — بلا رفعها يبقى الجهاز على باركوداتٍ خام لا تُطابَق.
    "v5",
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
        allowBackorder: products.allowBackorder,
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
    // (٤/٩، مراجعة Codex P2) نُصدّر الباركودات **مُطبَّعةً** (تقليم + طيّ الأرقام) ونُزيل التكرار: مطابقةُ
    // المسح أوفلاين تُطبّع مُدخلها (`offlineFindByBarcode`)، فلو بقيت اللقطة خاماً لتعذّر إيجادُ صفٍّ
    // إرثيّ مخزَّنٍ بأرقامٍ عربية-هندية أو فراغٍ طرفيّ — نظيرُ ما تشفيه القراءةُ أونلاين.
    const allBarcodes = Array.from(
      new Set([r.barcode, ...aliases].map((b) => canonicalizeBarcodeInput(b ?? "")).filter(Boolean)),
    );
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
      barcode: canonicalizeBarcodeInput(r.barcode ?? "") || null,
      allBarcodes,
      isBaseUnit: !!r.isBaseUnit,
      isService: !!r.isService,
      allowBackorder: !!r.allowBackorder,
      isBundle: !!r.isBundle,
      isCustomizable: !!r.isCustomizable,
      // Codex P2 (٢٤/٨ على PR #755): هذا الحقل هويّةٌ تشغيليّة لا مؤشّرَ رؤية —
      // `offlineSearchCatalog` يُقصي به الخدماتِ الطبيعيّة من نتائج كاشير التجزئة العامّ
      // ([`catalogSync.ts:241`](client/src/lib/offline/catalogSync.ts#L241)). لو أخفى المديرُ خدمةً
      // من شبكة الطباعة بجعل `showInPrintPos=FALSE`، فهي لا تزال خدمةَ طباعة تشغيلياً — لا يجب
      // أن تظهر في مسار كاشير التجزئة العامّ. الرؤيةُ (شبكة الطباعة) قرارٌ منفصل يديره
      // `printPos.services` الخادميّ مع كاشير الطباعة الخاصّ به (النسخة المحلّية في
      // `printServicesCache` تُحدَّث من نتيجته مباشرةً — لا اعتماد على لقطة الكتالوج العامّة).
      isPrintService: r.productType === "PRINT_SERVICE",
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
  // ٢٤/٨ (Codex P1×٤ على PR #737): الحلّ الساذج (branchStock + reservationStock) فقط كان يفوت:
  //   ⑴ تخصيصاتُ الطلبات الإلكترونيّة النشطة — تُطبَّق عبر `loadOnlineAllocatedBase` لا صفوف
  //      `reservationStock`، فتظهر وحداتٌ محجوزةٌ لطلبٍ Confirmed كأنّها متاحة للبيع في الأوفلاين.
  //   ⑵ طاقةُ البكج — بلا `branchStock` لأنّها مشتقّةٌ من أضعف مكوّن؛ الحلّ الساذج يعطيها ٠ فيبدو
  //      البكجُ نافداً بينما مكوّناتُه ممتلئة.
  //   ⑶/⑷ لقطاتٌ قديمة/فرعٌ مختلف — يعالجهما العميل بحرّاسٍ (نسخة عقد + META_STOCK_BRANCH).
  // الحلّ الجذريّ: نستعمل `loadVariantAvailability` — نفسُ المُحمِّل الحاكم الذي يستعمله
  // `posList` أونلاين — فيعطينا `availableBase` نهائياً بكلّ مصادر الحجز (رسميّ + إلكترونيّ +
  // بكج). نلتقط جميعَ variants الكتالوج الفعّالة كي تظهر البكجاتُ أيضاً.
  const allVariantRows = await db
    .select({ variantId: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(eq(products.isActive, true), eq(productVariants.isActive, true)));
  const variantIds = allVariantRows.map((r) => Number(r.variantId));
  if (variantIds.length === 0) return [];

  const availability = await loadVariantAvailability(db, branchId, variantIds);
  const rows: OfflineStockRow[] = [];
  for (const variantId of variantIds) {
    const a = availability.get(variantId);
    if (!a) continue;
    // الخدمة: لا رصيدَ لها ولا معنى للحجز — نتخطّاها (POS يعاملها لا-محدودة).
    if (a.isService) continue;
    rows.push({
      variantId,
      qty: a.onHandBase,
      reservedBase: a.reservedBase,
      availableBase: a.availableBase,
      isBundle: a.isBundle,
    });
  }
  return rows;
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
