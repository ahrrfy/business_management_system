// قراءات الكاشير (POS): مطابقة الباركود وقائمة البيع.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import { branchStock, productPrices, productUnits, productVariants, products, reservationStock } from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { resolveContractPrices } from "../contractPriceService";
import { money, toDbMoney } from "../money";
import type { PriceTier } from "../pricing";
import { PRINT_SERVICE_TYPE } from "../printSaleService";
import { getProductCategoryIds, resolvePromotionForLine } from "../salesPromotionService";
import { withTx } from "../tx";
import { barcodeAmbiguityMessage, resolveBarcodeOwnerResult } from "./barcodeAliases";
import { activeOnly, buildCatalogSearchOrder, buildCatalogSearchWhere, posVisibility } from "./search";
import { loadBundleUnitCosts } from "../bundleService";
import { loadVariantAvailability } from "./variantAvailability";
import { titleForChannel } from "@shared/productChannelTitles";

/** One sellable line for the POS: a (variant × unit) with its tier price and branch stock. */
export interface PosRow {
  /** الفرع الفعلي الذي قرأه الخادم بعد تطبيق عزل الحساب؛ لا يُستنتج من طلب العميل. */
  branchId: number;
  productId: number;
  productName: string;
  variantId: number;
  variantName: string | null;
  color: string | null;
  /** لون العرض «#RRGGBB» من بنك الألوان (اختيار صريح؛ null ⇒ يُستنتَج من الاسم). يُغذّي رمز اللون على الملصق. */
  colorHex: string | null;
  size: string | null;
  sku: string;
  productUnitId: number;
  unitName: string;
  conversionFactor: string;
  barcode: string | null;
  isBaseUnit: boolean;
  price: string | null; // null = no price defined for this unit×tier
  stockBase: number; // variant stock in base units at the branch (الرصيد الفعليّ)
  reservedBase: number; // المحجوز النشط بوحدة الأساس (الحجوزات R-م٤)
  availableBase: number; // المتاح التشغيلي للبيع = max(0, stockBase − reservedBase)
  /** «وضع الافتتاح» (ش٥): لحظة تثبيت الرصيد الافتتاحي — null = غير مُفتتَح (يُباع نقداً بالسالب أثناء النافذة). */
  openedAt: Date | null;
  isService: boolean; // مُنتج خِدمي: لا مَخزون، POS يَتجاوز فَحص نَقص المَخزون.
  // «يُباع بالطلب» (0318): صنفٌ مخزنيّ يُسمح ببيعه قبل توريده — الكاشير لا يراه «نافذاً»،
  // ورصيدُه ينزل بالسالب عدّادَ التزامٍ يرفعه الشراء (فاتورة مورّد) أو الإنتاج الداخليّ.
  allowBackorder: boolean;
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
  /**
   * تكلفة الوحدة الأساس (من `productVariants.costPrice`). يُحمَل دائماً في الحمولة كي تستعمله
   * شاشات المبيعات المتقدّمة (`SalesInvoiceNew` — عمود «التكلفة» والهامش٪) عبر شريط البحث
   * والإضافة المتعدّدة الموحَّدين مع مسار الشراء. الحجب يتمّ **في الراوتر** عبر
   * `canSeeCostForUser` — يُستبدَل بـnull لغير المخوَّلين (كاشير) قبل الإرسال، فلا تتسرّب
   * التكلفة عبر شبكة tRPC. القيمة بوحدة الأساس (لا مضروبة بمعامل التحويل) — نمط `PurchaseRow`.
   */
  costPriceBase: string | null;
}

/** لقطة خفيفة لتحديث أسطر السلة دون إعادة التسعير أو تشغيل العروض. */
export interface CatalogStockSnapshotRow {
  branchId: number;
  productUnitId: number;
  variantId: number;
  stockBase: number;
  reservedBase: number;
  availableBase: number;
  openedAt: Date | null;
  isService: boolean;
  allowBackorder: boolean;
  isBundle: boolean;
}

function baseSelect(db: NonNullable<ReturnType<typeof getDb>>, branchId: number, tier: PriceTier) {
  return db
    .select({
      productId: products.id,
      productName: products.name,
      posLabel: products.posLabel,
      shortTitle: products.shortTitle,
      variantId: productVariants.id,
      variantName: productVariants.variantName,
      color: productVariants.color,
      colorHex: productVariants.colorHex,
      size: productVariants.size,
      sku: productVariants.sku,
      productUnitId: productUnits.id,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      barcode: productUnits.barcode,
      isBaseUnit: productUnits.isBaseUnit,
      price: productPrices.price,
      costPriceBase: productVariants.costPrice,
      stockBase: branchStock.quantity,
      reservedBase: reservationStock.reservedBase,
      // «وضع الافتتاح» (ش٥): يتيح لواجهة POS تمييز الصنف غير المُفتتَح (يُباع نقداً بالسالب
      // أثناء النافذة) عن «نافذ» الصارم — الحارس الفعلي خادميّ في sale/create بأي حال.
      openedAt: branchStock.openedAt,
      isService: products.isService,
      allowBackorder: products.allowBackorder,
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
    )
    .leftJoin(
      reservationStock,
      and(eq(reservationStock.variantId, productVariants.id), eq(reservationStock.branchId, branchId))
    );
}

function normalize(rows: any[], branchId: number): PosRow[] {
  return rows.map((r) => ({
    ...r,
    branchId,
    productName: titleForChannel({ name: r.productName, posLabel: r.posLabel, shortTitle: r.shortTitle }, "pos"),
    productId: Number(r.productId),
    variantId: Number(r.variantId),
    productUnitId: Number(r.productUnitId),
    isBaseUnit: !!r.isBaseUnit,
    stockBase: r.stockBase ?? 0,
    reservedBase: r.reservedBase ?? 0,
    // الرصيد الفعلي يبقى موقّعاً لإظهار السالب الحقيقي، لكن «المتاح للبيع» قيمة تشغيلية
    // لا يجوز أن تكون سالبة. تجاوز الحجز يبقى ظاهراً من reservedBase > stockBase.
    availableBase: Math.max(0, (r.stockBase ?? 0) - (r.reservedBase ?? 0)),
    openedAt: r.openedAt ?? null,
    isService: !!r.isService,
    allowBackorder: !!r.allowBackorder,
    isCustomizable: !!r.isCustomizable,
    isPrintService: r.productType === PRINT_SERVICE_TYPE,
    isContractPrice: false,
    isBundle: !!r.isBundle,
    isConsignment: !!r.isConsignment,
    promotionId: null,
    promotionName: null,
    promotionDiscountForUnit: "0.00",
    promotionEffectivePrice: null,
    costPriceBase: r.costPriceBase ?? null,
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
 * تكلفة البكج مشتقّة من وصفته (`productVariants.costPrice` له صفرٌ بحكم التصميم).
 * تُطبَّق على صفوف POS **الحاملة للتكلفة** حصراً — تلك التي يحجب الراوتر تكلفتها عن
 * غير المخوَّلين عبر `redactPosCost`. لقطة المخزون (`listStockByUnitIds`) لا تحمل تكلفةً
 * أصلاً ولا تمرّ بالحجب، فإلحاق التكلفة بها كان سيسرّبها للكاشير.
 */
async function applyBundleUnitCost<T extends { variantId: number; isBundle: boolean; costPriceBase: string | null }>(
  db: NonNullable<ReturnType<typeof getDb>>,
  rows: T[],
): Promise<T[]> {
  const bundleVariantIds = rows.flatMap((row) => row.isBundle ? [row.variantId] : []);
  if (!bundleVariantIds.length) return rows;
  const costs = await loadBundleUnitCosts(db, bundleVariantIds);
  return rows.map((r) => (r.isBundle && costs.has(r.variantId) ? { ...r, costPriceBase: costs.get(r.variantId)! } : r));
}

/**
 * يطبّق لقطة ATP الحاكمة على كل صفوف POS، لا البكجات وحدها. بذلك يقرأ الكاشير
 * وشاشة المنتجات والمتجر المصدر نفسه: الرصيد الفعلي الموقّع ناقص الحجوزات الرسمية
 * وتخصيصات الطلبات الإلكترونية النشطة؛ والبكج مشتق مرةً واحدة من مكوّناته.
 */
async function applyBundleAvailability<
  T extends { variantId: number; isBundle: boolean; stockBase: number; reservedBase: number; availableBase: number },
>(
  db: NonNullable<ReturnType<typeof getDb>>,
  rows: T[],
  branchId: number,
): Promise<T[]> {
  if (!rows.length) return rows;
  const availability = await loadVariantAvailability(
    db,
    branchId,
    rows.map((row) => row.variantId),
  );
  return rows.map((r) => {
    const current = availability.get(r.variantId);
    if (!current) return { ...r, stockBase: 0, reservedBase: 0, availableBase: 0 };
    return {
      ...r,
      stockBase: current.onHandBase,
      reservedBase: current.reservedBase,
      availableBase: current.availableBase,
    };
  });
}

/**
 * يقرأ مخزون الوحدات الموجودة في سلة مفتوحة من مصدر الحقيقة الحالي. لا أسعار ولا عروض هنا؛
 * لذلك يصلح للتحديث الدوري الرخيص ويمنع بقاء لقطة سلة/مسودة قديمة بعد بيع أو تسوية مخزون.
 */
export async function listStockByUnitIds(
  productUnitIds: number[],
  branchId: number,
): Promise<CatalogStockSnapshotRow[]> {
  const db = getDb();
  if (!db || !productUnitIds.length) return [];
  const rows = await db
    .select({
      productUnitId: productUnits.id,
      variantId: productVariants.id,
      stockBase: branchStock.quantity,
      reservedBase: reservationStock.reservedBase,
      openedAt: branchStock.openedAt,
      isService: products.isService,
      allowBackorder: products.allowBackorder,
      isBundle: products.isBundle,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(
      branchStock,
      and(eq(branchStock.variantId, productVariants.id), eq(branchStock.branchId, branchId)),
    )
    .leftJoin(
      reservationStock,
      and(eq(reservationStock.variantId, productVariants.id), eq(reservationStock.branchId, branchId)),
    )
    .where(inArray(productUnits.id, productUnitIds));

  const normalized: CatalogStockSnapshotRow[] = rows.map((row) => {
    const stockBase = row.stockBase ?? 0;
    const reservedBase = row.reservedBase ?? 0;
    return {
      branchId,
      productUnitId: Number(row.productUnitId),
      variantId: Number(row.variantId),
      stockBase,
      reservedBase,
      availableBase: Math.max(0, stockBase - reservedBase),
      openedAt: row.openedAt ?? null,
      isService: !!row.isService,
      allowBackorder: !!row.allowBackorder,
      isBundle: !!row.isBundle,
    };
  });
  return applyBundleAvailability(db, normalized, branchId);
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
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const resolution = await resolveBarcodeOwnerResult(db, barcode);
  if (resolution.status === "NOT_FOUND") return null;
  if (resolution.status === "AMBIGUOUS") {
    throw new TRPCError({
      code: "CONFLICT",
      message: barcodeAmbiguityMessage("تعذّر إضافة الصنف الممسوح إلى الكاشير"),
    });
  }
  const owner = resolution.owner;
  const rows = await baseSelect(db, branchId, tier)
    .where(and(activeOnly, eq(productUnits.id, owner.productUnitId)))
    .limit(1);
  if (!rows.length) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر إضافة الصنف الممسوح إلى الكاشير",
        why: "المنتج أو متغيّره أو وحدة الباركود معطّلة أو غير قابلة للبيع في الكاشير",
        doThis: "راجع تفعيل المنتج والمتغيّر والوحدة ونوع المنتج، ثم أعد المسح",
      }),
    });
  }
  const priced = await applyContractPrices(db, normalize(rows, branchId), customerId);
  const withAvail = await applyBundleUnitCost(db, await applyBundleAvailability(db, priced, branchId));
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
  const priced = await applyContractPrices(db, normalize(rows, branchId), null);
  const withAvail = await applyBundleUnitCost(db, await applyBundleAvailability(db, priced, branchId));
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
  const priced = await applyContractPrices(db, normalize(rows, branchId), null);
  const withAvail = await applyBundleUnitCost(db, await applyBundleAvailability(db, priced, branchId));
  return applyPromotions(withAvail, branchId, tier);
}

/** List sellable rows for the POS, optionally filtered by a text query.
 *  includeReceptionServices=true يُظهر خدمات الطباعة المفعَّل عليها showInReception (كاشير الاستقبال).
 *  includeAllServices=true (١٢/٨/٢٦) يُظهر **كل** خدمات الطباعة (بلا شرط showInReception) — لشاشة
 *    فاتورة البيع المتقدّمة. يتقدَّم على includeReceptionServices إن حدَّدَ العميل الاثنين.
 *  opts.customerId (بند 12ب): يُطبّق الأسعار التعاقدية النشطة للعميل على الصفوف المطابقة. */
export async function listForPos(
  branchId: number,
  tier: PriceTier,
  query?: string,
  limit = 200,
  opts?: { includeReceptionServices?: boolean; includeAllServices?: boolean; customerId?: number | null },
): Promise<PosRow[]> {
  const db = getDb();
  if (!db) return [];
  const mode = opts?.includeAllServices ? "advancedSale" : opts?.includeReceptionServices ? "reception" : "default";
  const active = posVisibility(mode);
  const search = buildCatalogSearchWhere(query);
  const where = search ? and(active, search) : active;
  const order = search ? buildCatalogSearchOrder(query) : [desc(products.id)];
  const rows = await baseSelect(db, branchId, tier).where(where).orderBy(...order).limit(limit);
  const priced = await applyContractPrices(db, normalize(rows, branchId), opts?.customerId);
  const withAvail = await applyBundleUnitCost(db, await applyBundleAvailability(db, priced, branchId));
  return applyPromotions(withAvail, branchId, tier);
}
