// قراءات الكاشير (POS): مطابقة الباركود وقائمة البيع.
import { and, desc, eq, inArray } from "drizzle-orm";
import { branchStock, bundleComponents, productPrices, productUnits, productVariants, products } from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { resolveContractPrices } from "../contractPriceService";
import { money, toDbMoney } from "../money";
import type { PriceTier } from "../pricing";
import { PRINT_SERVICE_TYPE } from "../printSaleService";
import { getProductCategoryIds, resolvePromotionForLine } from "../salesPromotionService";
import { withTx } from "../tx";
import { resolveBarcodeOwner } from "./barcodeAliases";
import { activeOnly, buildCatalogSearchOrder, buildCatalogSearchWhere, posVisibility } from "./search";

/** One sellable line for the POS: a (variant × unit) with its tier price and branch stock. */
export interface PosRow {
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  size: string | null;
  sku: string;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  barcode: string | null;
  isBaseUnit: boolean;
  price: string | null; // null = no price defined for this unit×tier
  stockBase: number; // variant stock in base units at the branch
  /** «وضع الافتتاح» (ش٥): لحظة تثبيت الرصيد الافتتاحي — null = غير مُفتتَح (يُباع نقداً بالسالب أثناء النافذة). */
  openedAt: Date | null;
  isService: boolean; // مُنتج خِدمي: لا مَخزون، POS يَتجاوز فَحص نَقص المَخزون.
  // شاشة الاستقبال الهجينة: المنتج المخصّص يفتح نافذة التخصيص بدل الإضافة المباشرة للسلّة.
  isCustomizable: boolean;
  // خدمة طباعة (productType=PRINT_SERVICE): تُباع عبر مسار createPrintSale (خصم مواد + COGS) لا sales.create.
  isPrintService: boolean;
  // بند 12ب: السعر المعروض سعرٌ تعاقدي خاص بالعميل المُمرَّر (يتقدّم على سعر الفئة) — الواجهة تُظهر شارة.
  isContractPrice: boolean;
  // gstack B10 (٧/٧/٢٦): البكج بلا branchStock ذاتي — POS يعرض توفّراً **مشتقاً** = min(floor(componentStock/qty))
  // على مكوّناته. isBundle=true يشغّل الشارة والعدّ عبر `applyBundleAvailability`. المكوّن الأشحّ يحدّد الحدّ.
  isBundle: boolean;
  // بضاعة الأمانة (٢٠/٧): صنف برسم البيع لطرف خارجي — شارة عرضية في نتيجة بحث POS (تفيد الكاشير
  // عند أسئلة الزبون/الإرجاع). البيع طبيعيّ تماماً؛ الالتزام للمودِع يُلتقَط خادمياً.
  isConsignment: boolean;
  // promotions v2 (٨/٧/٢٦، gstack B1+B2): «نقطة العرض = نقطة الفرض». `price` أعلاه = السعر الأصلي
  // (سعر الفئة أو التعاقدي). `promotionDiscountForUnit` هو الخصم لكل وحدة (>0 لو ينطبق عرض).
  // `promotionEffectivePrice` = `price - promotionDiscountForUnit` — الكاشير يعرضه للعميل ويبني منه
  // payment.amount ⇒ لا انحراف بين ما يعرضه ويحصّله وما يسجّله الخادم (يحلّ B2).
  // `promotionId`+`promotionName` للتدقيق/الشارة. سعر تعاقدي؟ العرض لا ينطبق (contract wins).
  promotionId: number | null;
  promotionName: string | null;
  promotionDiscountForUnit: string; // "0.00" لو لا عرض
  promotionEffectivePrice: string | null; // السعر بعد الخصم — null لو لا عرض (المستهلك يستعمل price)
}

function baseSelect(db: NonNullable<ReturnType<typeof getDb>>, branchId: number, tier: PriceTier) {
  return db
    .select({
      productId: products.id,
      productName: products.name,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      size: productVariants.size,
      sku: productVariants.sku,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      barcode: productUnits.barcode,
      isBaseUnit: productUnits.isBaseUnit,
      price: productPrices.price,
      stockBase: branchStock.quantity,
      // «وضع الافتتاح» (ش٥): يتيح لواجهة POS تمييز الصنف غير المُفتتَح (يُباع نقداً بالسالب
      // أثناء النافذة) عن «نافذ» الصارم — الحارس الفعلي خادميّ في sale/create بأي حال.
      openedAt: branchStock.openedAt,
      isService: products.isService,
      isCustomizable: products.isCustomizable,
      productType: products.productType,
      isBundle: products.isBundle,
      isConsignment: products.isConsignment,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      productPrices,
      and(eq(productPrices.productUnitId, productUnits.id), eq(productPrices.priceTier, tier))
    )
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId))
    );
}

function normalize(rows: any[]): PosRow[] {
  return rows.map((r) => ({
    ...r,
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productUnitId: Number(r.productUnitId),
    isBaseUnit: !!r.isBaseUnit,
    stockBase: r.stockBase ?? 0,
    openedAt: r.openedAt ?? null,
    isService: !!r.isService,
    isCustomizable: !!r.isCustomizable,
    isPrintService: r.productType === PRINT_SERVICE_TYPE,
    isContractPrice: false,
    isBundle: !!r.isBundle,
    isConsignment: !!r.isConsignment,
    promotionId: null,
    promotionName: null,
    promotionDiscountForUnit: "0.00",
    promotionEffectivePrice: null,
  }));
}

/** حبيبة اليوم المحلي (Baghdad UTC+3) بصيغة YYYY-MM-DD (B8 من gstack). */
function todayYmdBaghdad(): string {
  const now = new Date();
  // UTC+3 offset — بغداد لا تستعمل DST.
  const baghdad = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return baghdad.toISOString().slice(0, 10);
}

/**
 * promotions v2 (٨/٧/٢٦، gstack B1+B2+B8): يحلّ العرض المطبَّق على كل صفٍّ ويعرض السعر المخصوم.
 *   - يتخطّى الأسطر التي لها سعر تعاقدي (`isContractPrice=true`) — قرار المالك: التعاقدي يفوز.
 *   - يتخطّى البكجات (نطاق قرار: العروض على البكج نُخطّطها بعد استقرار موجة v2).
 *   - يتخطّى الخدمات (لا معنى لعرض «خصم» على خدمة مسعّرة كليّاً).
 *   - يستدعي `resolvePromotionForLine` لكل صفٍّ ناجٍ ⇒ يُعبّي promotionId/Name/DiscountForUnit/EffectivePrice.
 *
 * ملاحظة الأداء: النداء يمرّ بـ`withTx` قصير لكل قائمة (لا يمنع القفل — نستدعي بلا FOR UPDATE).
 * المستدعي: قائمة POS + مطابقة الباركود ⇒ ٥٠-٢٠٠ صف ⇒ استدعاء واحد لكل نداء API. مقبول.
 */
async function applyPromotions(
  rows: PosRow[],
  branchId: number,
  customerTier: PriceTier,
): Promise<PosRow[]> {
  if (!rows.length) return rows;
  const eligible = rows.filter(
    (r) => !r.isContractPrice && !r.isBundle && !r.isService && !r.isPrintService && r.price != null,
  );
  if (!eligible.length) return rows;

  const todayYmd = todayYmdBaghdad();
  const resolvedMap = new Map<number, { id: number; name: string; discountForUnit: string; effective: string }>();

  await withTx(async (tx: Tx) => {
    // productId + categoryId جماعياً — تجنّب N+1.
    const productIds = Array.from(new Set(eligible.map((r) => r.productId)));
    const categoryByProduct = await getProductCategoryIds(tx, productIds);

    for (const r of eligible) {
      const price = money(r.price!);
      const lineAmount = price; // كميّة 1 عند التسعير المعروض — Line-min filter عمليّاً لا يعمل لأنه على «إجمالي السطر» في العرض الأصلي؛ للـPOS نمرّر سعر الوحدة (خصمٌ min-line=0 يعمل، >0 يتخطّى لأن العميل يبني الكميّة لاحقاً).
      const res = await resolvePromotionForLine(tx, {
        branchId,
        customerTier,
        productId: r.productId,
        variantId: r.variantId,
        categoryId: categoryByProduct.get(r.productId) ?? null,
        unitPrice: price.toFixed(2),
        lineAmount: lineAmount.toFixed(2),
        hasContractPrice: false, // filtered above
        todayYmd,
      });
      if (res) {
        const effective = price.minus(money(res.discountForUnit));
        resolvedMap.set(r.productUnitId, {
          id: res.promotionId,
          name: res.promotionName,
          discountForUnit: res.discountForUnit,
          effective: toDbMoney(effective.lt(0) ? new (money("0").constructor as any)(0) : effective),
        });
      }
    }
  });

  return rows.map((r) => {
    const res = resolvedMap.get(r.productUnitId);
    if (!res) return r;
    return {
      ...r,
      promotionId: res.id,
      promotionName: res.name,
      promotionDiscountForUnit: res.discountForUnit,
      promotionEffectivePrice: res.effective,
    };
  });
}

/**
 * gstack B10 (٧/٧/٢٦): توفّر مشتق للبكج = min(floor(componentStock/componentBaseQuantity)) — عبر
 * قراءة واحدة لكل مكوّنات البكجات في القائمة. المكوّن الأشحّ يحدّد الحدّ. `isService`=true يُعامَل
 * كـ«لانهائي» (الخدمات بلا مخزون). إن كان المكوّن غير موجود في `branchStock` نعامله كصفر.
 */
async function applyBundleAvailability(
  db: NonNullable<ReturnType<typeof getDb>>,
  rows: PosRow[],
  branchId: number,
): Promise<PosRow[]> {
  const bundleVariantIds = rows.filter((r) => r.isBundle).map((r) => r.variantId);
  if (!bundleVariantIds.length) return rows;
  const uniqueBundleIds = Array.from(new Set(bundleVariantIds));

  // مكوّنات كل البكجات في القائمة (استعلام واحد بلا N+1).
  const compRows = await db
    .select({
      bundleVariantId: bundleComponents.bundleVariantId,
      componentVariantId: bundleComponents.componentVariantId,
      componentBaseQuantity: bundleComponents.componentBaseQuantity,
    })
    .from(bundleComponents)
    .where(inArray(bundleComponents.bundleVariantId, uniqueBundleIds));

  // أرصدة كل المكوّنات + علم isService (خدمات لا تُحدّ التوفّر) — استعلام واحد.
  const componentIds = Array.from(new Set(compRows.map((c) => Number(c.componentVariantId))));
  const stockAndKind = componentIds.length
    ? await db
        .select({
          variantId: productVariants.id,
          stock: branchStock.quantity,
          isService: products.isService,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(
          branchStock,
          and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)),
        )
        .where(inArray(productVariants.id, componentIds))
    : [];
  const stockByVid = new Map<number, { stock: number; isService: boolean }>();
  for (const s of stockAndKind) {
    stockByVid.set(Number(s.variantId), { stock: s.stock ?? 0, isService: !!s.isService });
  }

  // احسب حدّاً لكل بكج.
  const availByBundle = new Map<number, number>();
  for (const bid of uniqueBundleIds) {
    const comps = compRows.filter((c) => Number(c.bundleVariantId) === bid);
    if (!comps.length) {
      availByBundle.set(bid, 0);
      continue;
    }
    let min = Number.POSITIVE_INFINITY;
    for (const c of comps) {
      const info = stockByVid.get(Number(c.componentVariantId));
      if (!info) { min = 0; break; }
      if (info.isService) continue; // خدمة كمكوّن: لا تُحدّ (مسموحة عمداً).
      const qty = Number(c.componentBaseQuantity);
      const cap = qty > 0 ? Math.floor(info.stock / qty) : 0;
      if (cap < min) min = cap;
    }
    if (min === Number.POSITIVE_INFINITY) min = 0; // كل المكوّنات خدمات ⇒ لا نُظهر ∞، صفراً محايداً.
    availByBundle.set(bid, Math.max(0, min));
  }

  return rows.map((r) => (r.isBundle ? { ...r, stockBase: availByBundle.get(r.variantId) ?? 0 } : r));
}

/** بند 12ب: تراكب الأسعار التعاقدية — حين يُمرَّر customerId ولديه سعر تعاقدي نشط لوحدةٍ،
 *  يَستبدل السعرُ التعاقدي سعرَ الفئة في الصف مع علم isContractPrice (شارة في الواجهة).
 *  نفس `resolveContractPrices` التي يستهلكها الفرض في sale/create.ts ⇒ المعروض = المفروض. */
async function applyContractPrices(
  db: NonNullable<ReturnType<typeof getDb>>,
  rows: PosRow[],
  customerId?: number | null,
): Promise<PosRow[]> {
  if (!customerId || !rows.length) return rows;
  const map = await resolveContractPrices(db, customerId, rows.map((r) => r.productUnitId));
  if (!map.size) return rows;
  return rows.map((r) => {
    const p = map.get(r.productUnitId);
    return p == null ? r : { ...r, price: p, isContractPrice: true };
  });
}

/** Resolve a scanned barcode to a single POS row.
 *  customerId اختياري: يُطبّق السعر التعاقدي النشط للعميل إن وُجد (بند 12ب).
 *  البحث يمرّ على الأساسيّ (`productUnits.barcode`) والبديل (`productUnitBarcodes`) معاً. */
export async function lookupByBarcode(
  barcode: string,
  branchId: number,
  tier: PriceTier,
  customerId?: number | null,
): Promise<PosRow | null> {
  const db = getDb();
  if (!db) return null;
  const owner = await resolveBarcodeOwner(db, barcode);
  if (!owner) return null;
  const rows = await baseSelect(db, branchId, tier)
    .where(and(activeOnly, eq(productUnits.id, owner.productUnitId)))
    .limit(1);
  const priced = await applyContractPrices(db, normalize(rows), customerId);
  const withAvail = await applyBundleAvailability(db, priced, branchId);
  // promotions v2: يحلّ العرض للأسطر غير-التعاقدية غير-البكجية غير-الخدمية.
  const [row] = await applyPromotions(withAvail, branchId, tier);
  return row ?? null;
}

/**
 * قراءة دفعيّة لصفوف الكاشير بمعرّفات الوحدات — **نفس خطّ `lookupByBarcode` بالضبط**
 * (سعر الفئة ← التعاقديّ ← توفّر البكج ← العروض)، بحبيبة قائمةِ معرّفات واستعلامٍ واحد.
 *
 * سبب وجودها (١٦/٧، شاشة الملصقات): تبديل فئة السعر يجب أن يُعيد تسعير قائمة الطباعة.
 * الفتح بالباركود متعذّر هناك — الباركود الداخليّ (`ALR…`) غير المحفوظ ليس في القاعدة أصلاً —
 * والفتح صفّاً صفّاً N+1. وإعادةُ حساب السعر في الواجهة كانت ستفصل سعر الملصق عن سعر الكاشير،
 * وهي العلّة نفسها التي تُصلحها تلك الشاشة (ملصق يقول ١٠٠٠ وكاشير يحصّل ٨٠٠).
 */
export async function listByUnitIds(
  productUnitIds: number[],
  branchId: number,
  tier: PriceTier,
): Promise<PosRow[]> {
  const db = getDb();
  if (!db || !productUnitIds.length) return [];
  const rows = await baseSelect(db, branchId, tier).where(and(activeOnly, inArray(productUnits.id, productUnitIds)));
  const priced = await applyContractPrices(db, normalize(rows), null);
  const withAvail = await applyBundleAvailability(db, priced, branchId);
  return applyPromotions(withAvail, branchId, tier);
}

/**
 * كلّ الصفوف القابلة للبيع (متغيّر × وحدة) لمنتجاتٍ بعينها — تُغذّي «أضِف كلّ ألوان/وحدات
 * المنتج» في شاشة الملصقات دفعةً واحدة. نفس الخطّ أعلاه. الترتيب: المنتج ← المتغيّر ←
 * وحدة الأساس أوّلاً (الأكثر طباعةً على الرفّ).
 */
export async function listByProductIds(
  productIds: number[],
  branchId: number,
  tier: PriceTier,
): Promise<PosRow[]> {
  const db = getDb();
  if (!db || !productIds.length) return [];
  const rows = await baseSelect(db, branchId, tier)
    .where(and(activeOnly, inArray(products.id, productIds)))
    .orderBy(products.id, productVariants.id, desc(productUnits.isBaseUnit));
  const priced = await applyContractPrices(db, normalize(rows), null);
  const withAvail = await applyBundleAvailability(db, priced, branchId);
  return applyPromotions(withAvail, branchId, tier);
}

/** List sellable rows for the POS, optionally filtered by a text query.
 *  includeReceptionServices=true يُظهر خدمات الطباعة المفعَّل عليها showInReception (كاشير الاستقبال).
 *  opts.customerId (بند 12ب): يُطبّق الأسعار التعاقدية النشطة للعميل على الصفوف المطابقة. */
export async function listForPos(
  branchId: number,
  tier: PriceTier,
  query?: string,
  limit = 200,
  opts?: { includeReceptionServices?: boolean; customerId?: number | null },
): Promise<PosRow[]> {
  const db = getDb();
  if (!db) return [];
  const active = posVisibility(!!opts?.includeReceptionServices);
  const search = buildCatalogSearchWhere(query);
  const where = search ? and(active, search) : active;
  const order = search ? buildCatalogSearchOrder(query) : [desc(products.id)];
  const rows = await baseSelect(db, branchId, tier).where(where).orderBy(...order).limit(limit);
  const priced = await applyContractPrices(db, normalize(rows), opts?.customerId);
  const withAvail = await applyBundleAvailability(db, priced, branchId);
  return applyPromotions(withAvail, branchId, tier);
}
