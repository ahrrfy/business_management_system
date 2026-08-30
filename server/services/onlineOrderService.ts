/**
 * onlineOrderService — إنشاء/تتبّع طلب متجر الجوال (B2C — الدفع عند الاستلام).
 *
 * ⚠️ الأمان (نقاط فشل Antigravity التي نُغلقها):
 *  ① **لا انتحال مدير**: الطلب لا يُنشئ فاتورة ولا يمسّ الدفتر/المخزون ولا يحمل createdBy=userId.
 *     هو «طلبٌ» بحالة PENDING مربوطٌ بعميلٍ حقيقي (find-or-create بالهاتف) حتى يؤكّده الموظف.
 *  ② **السعر خادمي**: لا يُقبل أيّ سعر من العميل — يُقرأ سعر المفرد (RETAIL) من القاعدة لكل بند.
 *  ③ **التحقّق**: كل بند يجب أن يكون منتجاً فعّالاً غير خدمي بوحدة فعّالة ولها سعر مفرد.
 *  ④ **idempotency**: clientRequestId فريد ⇒ النقر المزدوج/إعادة المحاولة لا تُنشئ طلباً ثانياً.
 *  ⑤ **ذرّي**: كل ذلك داخل withTx — أيّ خطأ ⇒ ROLLBACK كامل.
 *
 * الأجرة = deliveryFeeFor(المحافظة) تقديرياً (يثبّتها الموظف عند الإسناد — شريحة ٤).
 */
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  bundleComponents,
  categories,
  customers,
  deliveryZones,
  onlineOrderItems,
  onlineOrders,
  productPrices,
  productUnits,
  productVariants,
  products,
  storeSettings as storeSettingsTable,
} from "../../drizzle/schema";
import { deliveryFeeFor, governorateById } from "@shared/governorates";
import { previewDeliveryQuote } from "./delivery/pricingRules";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { normalizeIraqPhoneE164 } from "../lib/phone";
import { money, round2, sumMoney, toDbMoney, toDbQty } from "./money";
import { resolvePromotionForLine } from "./salesPromotionService";
import { requireStorefrontContext } from "./storefrontContextService";
import { withTx } from "./tx";
import { lockCouponForSale, normalizeCouponCode, type LockedCoupon } from "./couponService";
import { resolveCouponPromotionForLine } from "./salesPromotionService";
import { verifyOnlineOrderLabelToken } from "./barcodeService";
import {
  loadVariantAvailability,
  lockProductUnitsForOnlineAllocation,
} from "./catalog/variantAvailability";
import { retryOnDup } from "../lib/retryDup";

const RETAIL = "RETAIL" as const;

/** حبيبة اليوم المحلي (بغداد UTC+3) YYYY-MM-DD — لتطابق نافذة العروض مع العرض في الكتالوج. */
function todayYmdBaghdad(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface OnlineOrderLineInput {
  productUnitId: number;
  quantity: number;
  /** السعر الذي ظهر للزبون عند التأكيد؛ لا يُستعمل للتسعير بل كـoptimistic contract. */
  expectedUnitPrice?: string | null;
}

export const MAX_ONLINE_ORDER_DISTINCT_UNITS = 30;
export const MAX_ONLINE_ORDER_QUANTITY_PER_UNIT = 999;
export const MAX_ONLINE_ORDER_TOTAL_QUANTITY = 10_000;

function normalizeExpectedUnitPrice(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  try {
    if (!/^\d{1,15}(?:\.\d{1,2})?$/.test(value)) throw new Error("invalid price shape");
    const parsed = money(value);
    if (!parsed.isFinite() || parsed.lt(0) || parsed.decimalPlaces() > 2) throw new Error("invalid price");
    return toDbMoney(parsed);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "السعر المتوقع لأحد المنتجات غير صحيح" });
  }
}

/**
 * عقد سلة علني موحّد للـquote والإنشاء: يدمج تكرار productUnitId قبل أي SQL، ويبقي كل لون
 * (وحدة/متغيّر مختلف) سطراً مستقلاً. الحدود تُطبّق بعد الدمج كي لا تتجاوزها دفعات مكررة.
 */
export function normalizeOnlineOrderLines(
  lines: ReadonlyArray<Pick<OnlineOrderLineInput, "productUnitId" | "quantity" | "expectedUnitPrice">>,
): OnlineOrderLineInput[] {
  if (!lines.length) throw new TRPCError({ code: "BAD_REQUEST", message: "السلة فارغة" });
  const normalized: OnlineOrderLineInput[] = [];
  const byUnit = new Map<number, OnlineOrderLineInput>();
  let totalQuantity = 0;

  for (const line of lines) {
    const productUnitId = line.productUnitId;
    const quantity = line.quantity;
    if (
      !Number.isSafeInteger(productUnitId) || productUnitId <= 0 ||
      !Number.isSafeInteger(quantity) || quantity <= 0
    ) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "كمية أو منتج غير صحيح" });
    }
    const expectedUnitPrice = normalizeExpectedUnitPrice(line.expectedUnitPrice);
    const current = byUnit.get(productUnitId);
    if (!current) {
      if (byUnit.size >= MAX_ONLINE_ORDER_DISTINCT_UNITS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `السلة تقبل ${MAX_ONLINE_ORDER_DISTINCT_UNITS} وحدة بيع مختلفة كحد أقصى`,
        });
      }
      const added = { productUnitId, quantity, expectedUnitPrice };
      byUnit.set(productUnitId, added);
      normalized.push(added);
    } else {
      if (
        current.expectedUnitPrice != null && expectedUnitPrice != null &&
        !money(current.expectedUnitPrice).eq(money(expectedUnitPrice))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "السعر المتوقع متضارب لنفس المنتج — حدّث السلة",
        });
      }
      current.quantity += quantity;
      if (current.expectedUnitPrice == null && expectedUnitPrice != null) {
        current.expectedUnitPrice = expectedUnitPrice;
      }
    }
    const mergedQuantity = byUnit.get(productUnitId)!.quantity;
    if (mergedQuantity > MAX_ONLINE_ORDER_QUANTITY_PER_UNIT) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الحد الأقصى لكمية المنتج الواحد ${MAX_ONLINE_ORDER_QUANTITY_PER_UNIT}`,
      });
    }
    totalQuantity += quantity;
    if (totalQuantity > MAX_ONLINE_ORDER_TOTAL_QUANTITY) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الحد الأقصى لمجموع كميات السلة ${MAX_ONLINE_ORDER_TOTAL_QUANTITY}`,
      });
    }
  }
  return normalized;
}

export interface CreateOnlineOrderInput {
  couponCode?: string | null;
  branchId?: number | null;
  customerName: string;
  customerPhone: string;
  governorate: string;
  addressText: string;
  latitude?: number | null;
  longitude?: number | null;
  notes?: string | null;
  lines: OnlineOrderLineInput[];
  /** الإجمالي المعروض شاملاً التوصيل؛ اختلافه عن إعادة التسعير المقفلة يرفض قبل إنشاء الطلب. */
  expectedGrandTotal?: string | null;
  clientRequestId?: string | null;
}

export interface CreateOnlineOrderResult {
  orderId: number;
  orderNumber: string;
  /** لقطة انتهاء حجز المخزون، تُحسب مرةً واحدة بساعة قاعدة البيانات. */
  reservationExpiresAt: Date;
  /** The server-resolved storefront branch; never supplied by the browser. */
  branchId: number;
  subtotal: string;
  deliveryFee: string;
  total: string;
  itemCount: number;
  idempotentReplay?: boolean;
}

/**
 * تطبيع رقم عراقي إلى صيغة E.164 قانونية واحدة (+964…) قبل استعماله في مفتاح القفل + البحث +
 * الإدراج (مراجعة عدائية ١٢/٧): بدونه «07701234567» و«+9647701234567» لنفس المشترك يعطيان مفتاحَي
 * قفل مختلفَين وتطابقَين مختلفَين ⇒ عميلان متكرّران. نُوحّدهما هنا فتتلاقى الصيغ على سجلّ واحد.
 *
 * (T3.1، بنك جهات الاتصال): المنطق انتُقل حرفياً إلى `server/lib/phone.ts` (normalizeIraqPhoneE164)
 * ليُشارَك مع customerService/supplierService — هذا التصدير توجيهٌ محض (صفر تغيير سلوكي، يحرسه
 * onlineOrderPhone.test.ts القائم).
 */
export function normalizeStorePhone(raw: string): string {
  return normalizeIraqPhoneE164(raw);
}

const REQUEST_KEY_CONFLICT =
  "رمز الطلب استُخدم لطلب مختلف — أنشئ رمزاً جديداً وحاول مجدداً";

/**
 * إعادة idempotent معزولة عن صاحبها. القراءة القافلة تُستعمل بعد variant mutex كي ترى
 * Current Read لطلبٍ التزم بينما كانت هذه المعاملة تنتظر، حتى تحت REPEATABLE READ.
 */
async function loadOwnedReplay(
  tx: Tx,
  input: CreateOnlineOrderInput,
  phone: string,
  requestedShippingAddress: string,
  requestedLineQuantities: ReadonlyMap<number, number>,
  lock = false,
): Promise<CreateOnlineOrderResult | null> {
  if (!input.clientRequestId) return null;
  const query = tx
    .select({
      id: onlineOrders.id,
      orderNumber: onlineOrders.orderNumber,
      customerId: onlineOrders.customerId,
      branchId: onlineOrders.branchId,
      subtotal: onlineOrders.subtotal,
      shippingCost: onlineOrders.shippingCost,
      total: onlineOrders.total,
      couponCode: onlineOrders.couponCode,
      governorate: onlineOrders.governorate,
      shippingAddress: onlineOrders.shippingAddress,
      reservationExpiryMs: sql<number | null>`ROUND(UNIX_TIMESTAMP(COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR))) * 1000)`,
    })
    .from(onlineOrders)
    .where(eq(onlineOrders.clientRequestId, input.clientRequestId))
    .limit(1);
  const existing = (lock ? await query.for("update") : await query)[0];
  if (!existing) return null;

  const ownerQuery =
    existing.customerId == null
      ? null
      : tx
          .select({
            phone: customers.phone,
            phone2: customers.phone2,
            phone3: customers.phone3,
            whatsapp: customers.whatsapp,
          })
          .from(customers)
          .where(eq(customers.id, Number(existing.customerId)))
          .limit(1);
  const owner =
    ownerQuery == null
      ? null
      : ((lock ? await ownerQuery.for("update") : await ownerQuery)[0] ?? null);
  if (
    !owner ||
    ![owner.phone, owner.phone2, owner.phone3, owner.whatsapp].includes(phone)
  ) {
    // لا نُفصح هل المفتاح موجود ولا رقم الطلب ولا المبلغ للطرف الآخر.
    throw new TRPCError({ code: "CONFLICT", message: REQUEST_KEY_CONFLICT });
  }

  const linesQuery = tx
    .select({
      productUnitId: onlineOrderItems.productUnitId,
      quantity: onlineOrderItems.quantity,
    })
    .from(onlineOrderItems)
    .where(eq(onlineOrderItems.onlineOrderId, Number(existing.id)));
  const existingLines = lock
    ? await linesQuery.for("update")
    : await linesQuery;
  const storedLineQuantities = new Map<number, number>();
  for (const line of existingLines) {
    const unitId = Number(line.productUnitId);
    storedLineQuantities.set(
      unitId,
      (storedLineQuantities.get(unitId) ?? 0) + Number(line.quantity),
    );
  }
  const sameLines =
    storedLineQuantities.size === requestedLineQuantities.size &&
    Array.from(requestedLineQuantities.entries()).every(
      ([unitId, quantity]) => storedLineQuantities.get(unitId) === quantity,
    );
  const requestedCouponCode = input.couponCode ? normalizeCouponCode(input.couponCode) : null;
  const existingCouponCode = existing.couponCode ? normalizeCouponCode(existing.couponCode) : null;
  if (
    existing.governorate !== input.governorate ||
    existing.shippingAddress !== requestedShippingAddress ||
    existingCouponCode !== requestedCouponCode ||
    !sameLines
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "رمز الطلب استُخدم لطلب مختلف — أعد تحميل السلة وحاول مجدداً",
    });
  }
  return {
    orderId: Number(existing.id),
    orderNumber: existing.orderNumber,
    reservationExpiresAt: existing.reservationExpiryMs != null ? new Date(Number(existing.reservationExpiryMs)) : (() => {
      throw new Error("Existing online order is missing its reservation expiry snapshot");
    })(),
    branchId: Number(existing.branchId),
    subtotal: String(existing.subtotal),
    deliveryFee: String(existing.shippingCost),
    total: String(existing.total),
    itemCount: existingLines.length,
    idempotentReplay: true,
  };
}

/** قفل العميل هو أول قفل أعمال مشترك، قبل المخزون، اتساقاً مع createSale/POS. */
async function lockOrCreateOnlineCustomer(tx: Tx, phone: string, name: string): Promise<number> {
  const custLock = `online-customer:${phone}`;
  const lockRes = (await tx.execute(sql`SELECT GET_LOCK(${custLock}, 5) AS locked`)) as unknown;
  const lockedRow = Array.isArray(lockRes)
    ? (lockRes[0] as { locked?: number }[])?.[0]
    : (lockRes as { rows?: { locked?: number }[] })?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تأمين إنشاء العميل — أعد المحاولة" });
  }
  try {
    const existing = (
      await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.phone, phone))
        .limit(1)
        .for("update")
    )[0];
    if (existing) return Number(existing.id);
    const inserted = await tx.insert(customers).values({
      name,
      phone,
      customerType: "فرد",
      defaultPriceTier: RETAIL,
      creditLimit: "0",
      currentBalance: "0",
      isActive: true,
    });
    return extractInsertId(inserted);
  } finally {
    // named lock للتسلسل المبكر فقط؛ قفل صف/فجوة العميل يبقى حتى COMMIT.
    await tx.execute(sql`SELECT RELEASE_LOCK(${custLock})`);
  }
}

interface PricedOnlineOrderLine {
  productId: number;
  categoryId: number | null;
  variantId: number;
  productName: string;
  isBundle: boolean;
  productUnitId: number;
  quantity: number;
  baseQuantity: number;
  retailUnitPrice: string;
  discountPerUnit: string;
  unitPrice: string;
  lineTotal: string;
  couponDiscountPerUnit?: string;
}

export interface OnlineOrderQuoteInput {
  couponCode?: string | null;
  governorate: string;
  lines: Array<Pick<OnlineOrderLineInput, "productUnitId" | "quantity">>;
}

export interface OnlineOrderQuoteResult {
  couponCode: string | null;
  couponProgramName: string | null;
  couponDiscount: string;
  lines: Array<{
    productUnitId: number;
    quantity: number;
    retailUnitPrice: string;
    discountPerUnit: string;
    unitPrice: string;
    lineTotal: string;
  }>;
  subtotal: string;
  deliveryFee: string;
  total: string;
}

/** محرك التسعير الوحيد للـquote وللتثبيت؛ lineAmount يستعمل كمية السلة الفعلية. */
async function priceOnlineOrderLines(
  tx: Tx,
  branchId: number,
  lines: Array<Pick<OnlineOrderLineInput, "productUnitId" | "quantity">>,
  options: { lock: boolean; coupon?: LockedCoupon | null },
): Promise<PricedOnlineOrderLine[]> {
  const unitIds = Array.from(new Set(lines.map((line) => Number(line.productUnitId)))).sort((a, b) => a - b);
  const query = tx
    .select({
      productId: products.id,
      productName: products.name,
      categoryId: products.categoryId,
      productUnitId: productUnits.id,
      variantId: productVariants.id,
      conversionFactor: productUnits.conversionFactor,
      unitActive: productUnits.isActive,
      unitAvailableInStore: productUnits.isStoreSaleUnit,
      variantActive: productVariants.isActive,
      productActive: products.isActive,
      showInStore: products.showInStore,
      categoryActive: categories.isActive,
      categoryShowInStore: categories.showInStore,
      isService: products.isService,
      isBundle: products.isBundle,
      price: productPrices.price,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(productPrices, and(
      eq(productPrices.productUnitId, productUnits.id),
      eq(productPrices.priceTier, RETAIL),
    ))
    .where(inArray(productUnits.id, unitIds))
    .orderBy(asc(productUnits.id));
  const rows = options.lock ? await query.for("update") : await query;
  const byUnit = new Map(rows.map((row) => [Number(row.productUnitId), row]));
  const todayYmd = todayYmdBaghdad();
  const priced: PricedOnlineOrderLine[] = [];
  for (const line of lines) {
    const quantity = Math.floor(line.quantity);
    const row = byUnit.get(Number(line.productUnitId));
    if (
      !Number.isSafeInteger(quantity) || quantity <= 0 || !row || !row.productActive ||
      !row.showInStore || (row.categoryId != null && (!row.categoryActive || !row.categoryShowInStore)) ||
      row.isService || !row.variantActive || !row.unitActive || !row.unitAvailableInStore || row.price == null
    ) {
      throw new TRPCError({
        code: options.lock ? "CONFLICT" : "BAD_REQUEST",
        message: "أحد المنتجات لم يعُد متاحاً — حدّث السلة",
      });
    }
    const base = money(quantity).times(row.conversionFactor ?? 1);
    if (!base.isInteger() || !base.gt(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "كمية الوحدة لا تتحول إلى كمية أساس صحيحة" });
    }
    const retail = round2(row.price);
    const productId = Number(row.productId);
    const variantId = Number(row.variantId);
    const categoryId = row.categoryId == null ? null : Number(row.categoryId);
    const promo = await resolvePromotionForLine(tx, {
      branchId,
      customerTier: RETAIL,
      productId,
      variantId,
      categoryId,
      unitPrice: retail.toFixed(2),
      lineAmount: retail.times(quantity).toFixed(2),
      hasContractPrice: false,
      todayYmd,
      includeStoreManaged: true,
      lockForUpdate: options.lock,
    });
    const automaticDiscount = promo ? money(promo.discountForUnit) : money(0);
    const priceAfterAutomatic = round2(retail.minus(automaticDiscount).lt(0) ? money(0) : retail.minus(automaticDiscount));
    const couponPromo = options.coupon
      ? await resolveCouponPromotionForLine(tx, options.coupon.promotionId, {
          branchId,
          customerTier: RETAIL,
          productId,
          variantId,
          categoryId,
          unitPrice: priceAfterAutomatic.toFixed(2),
          lineAmount: priceAfterAutomatic.times(quantity).toFixed(2),
          hasContractPrice: false,
          todayYmd,
          includeStoreManaged: true,
          lockForUpdate: options.lock,
        })
      : null;
    const couponDiscount = couponPromo ? money(couponPromo.discountForUnit) : money(0);
    const discount = automaticDiscount.plus(couponDiscount).gt(retail)
      ? retail
      : automaticDiscount.plus(couponDiscount);
    const unitPrice = round2(retail.minus(discount).lt(0) ? money(0) : retail.minus(discount));
    priced.push({
      productId,
      categoryId,
      variantId,
      productName: row.productName,
      isBundle: row.isBundle === true,
      productUnitId: Number(row.productUnitId),
      quantity,
      baseQuantity: base.toNumber(),
      retailUnitPrice: retail.toFixed(2),
      discountPerUnit: round2(discount).toFixed(2),
      couponDiscountPerUnit: round2(couponDiscount).toFixed(2),
      unitPrice: unitPrice.toFixed(2),
      lineTotal: round2(unitPrice.times(quantity)).toFixed(2),
    });
  }
  return priced;
}

/**
 * H3 (٢٩/٨/٢٦): مصدرُ الأجرة يتبع الأولويّة التالية:
 *   ① جدول `deliveryPricingRules` عبر `deliveryZones.code = governorate` (المدير عدّل الأجرة)
 *   ② الافتراض الثابت من `governorates.ts` (السلوك السابق — يبقى للتوافق ولمناطق بلا زون)
 * البذرة (H4، هجرة 0290) تنقل كلّ المحافظات الثمانية عشرة إلى المسار ①.
 */
async function resolveDeliveryFee(tx: Tx, governorate: string): Promise<import("decimal.js").default> {
  const zone = (
    await tx.select({ id: deliveryZones.id, isActive: deliveryZones.isActive })
      .from(deliveryZones).where(eq(deliveryZones.code, governorate)).limit(1)
  )[0];
  if (zone && zone.isActive) {
    const quote = await previewDeliveryQuote(tx, Number(zone.id), null, null);
    if (quote) return round2(money(quote.fee));
  }
  return round2(deliveryFeeFor(governorate));
}

async function totalOnlineOrderQuote(
  tx: Tx,
  items: Array<{ lineTotal: string }>,
  governorate: string,
  freeShippingThreshold: string | null | undefined,
): Promise<Pick<OnlineOrderQuoteResult, "subtotal" | "deliveryFee" | "total">> {
  const subtotal = round2(sumMoney(items.map((item) => item.lineTotal)));
  let deliveryFee = await resolveDeliveryFee(tx, governorate);
  const freeThreshold = freeShippingThreshold ? money(freeShippingThreshold) : null;
  if (freeThreshold && freeThreshold.gt(0) && subtotal.gte(freeThreshold)) deliveryFee = round2(money(0));
  return {
    subtotal: subtotal.toFixed(2),
    deliveryFee: deliveryFee.toFixed(2),
    total: round2(subtotal.plus(deliveryFee)).toFixed(2),
  };
}

export async function quoteOnlineOrder(input: OnlineOrderQuoteInput): Promise<OnlineOrderQuoteResult> {
  const normalizedLines = normalizeOnlineOrderLines(input.lines);
  if (!governorateById(input.governorate)) throw new TRPCError({ code: "BAD_REQUEST", message: "المحافظة غير صحيحة" });
  // تسعيرةٌ قارئةٌ محضة: **بلا بوّابة الكتابة الماليّة** (فحص الحمل ٣١/٨/٢٦). كانت تأخذ
  // `FINANCIAL_WRITER` (قفلٌ مشترك على صفّ بوّابة الإقفال العالميّ) في كل نداءٍ مجهول من كلّ
  // زائر، وهي لا تكتب شيئاً إطلاقاً — والمعاملة تبقى قائمةً لضمان لقطةٍ متّسقة للأسعار
  // والتوفّر عبر الاستعلامات المتعدّدة، لا للذرّية.
  return withTx(async (tx) => {
    const context = await requireStorefrontContext(tx, { requireOpen: true });
    const settings = (await tx.select({ freeShippingThreshold: storeSettingsTable.freeShippingThreshold })
      .from(storeSettingsTable).where(eq(storeSettingsTable.id, 1)).limit(1))[0];
    // بلا `FOR UPDATE` على الكوبون: التسعيرة لا تستهلك استخداماً، والقفل الحصريّ كان يُسلسل
    // كلّ زائرٍ يجرّب الرمز نفسه. حماية الاستهلاك المزدوج تبقى في مسار الإنشاء (lock افتراضيّ).
    const lockedCoupon = input.couponCode
      ? await lockCouponForSale(
          tx,
          { code: input.couponCode, branchId: context.branchId, customerId: null, todayYmd: todayYmdBaghdad() },
          { lock: false },
        )
      : null;
    const items = await priceOnlineOrderLines(tx, context.branchId, normalizedLines, { lock: false, coupon: lockedCoupon });
    const couponDiscountTotal = round2(items.reduce((sum, item) => sum.plus(money(item.couponDiscountPerUnit ?? "0").times(item.quantity)), money(0)));
    if (lockedCoupon && couponDiscountTotal.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون لا ينطبق على أصناف السلة" });
    const totals = await totalOnlineOrderQuote(tx, items, input.governorate, settings?.freeShippingThreshold);
    return {
      couponCode: lockedCoupon?.code ?? null,
      couponProgramName: lockedCoupon?.programName ?? null,
      couponDiscount: couponDiscountTotal.toFixed(2),
      lines: items.map((item) => ({
        productUnitId: item.productUnitId,
        quantity: item.quantity,
        retailUnitPrice: item.retailUnitPrice,
        discountPerUnit: item.discountPerUnit,
        couponDiscountPerUnit: item.couponDiscountPerUnit ?? "0.00",
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      })),
      ...totals,
    };
  }, { gate: "NONE" });
}

/** طلب متجر جديد — server-priced، مُتحقَّق، idempotent، ذرّي. لا أثر مالي (PENDING فقط). */
export async function createOnlineOrder(
  input: CreateOnlineOrderInput,
): Promise<CreateOnlineOrderResult> {
  return retryOnDup(() => createOnlineOrderAttempt(input));
}

function normalizeOwnedReplayIdentity(input: CreateOnlineOrderInput) {
  const normalizedLines = normalizeOnlineOrderLines(input.lines);
  const gov = governorateById(input.governorate);
  if (!gov)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "المحافظة غير معروفة",
    });
  const name = input.customerName.trim();
  const phone = normalizeStorePhone(input.customerPhone);
  if (!name)
    throw new TRPCError({ code: "BAD_REQUEST", message: "الاسم مطلوب" });
  if (!phone)
    throw new TRPCError({ code: "BAD_REQUEST", message: "رقم الهاتف مطلوب" });
  const address = input.addressText.trim();
  if (!address)
    throw new TRPCError({ code: "BAD_REQUEST", message: "العنوان مطلوب" });
  const requestedLineQuantities = new Map<number, number>();
  for (const line of normalizedLines) {
    requestedLineQuantities.set(line.productUnitId, line.quantity);
  }
  const requestedShippingAddress =
    input.notes && input.notes.trim()
      ? `${address}\nملاحظة: ${input.notes.trim()}`
      : address;
  return {
    normalizedLines,
    name,
    phone,
    requestedLineQuantities,
    requestedShippingAddress,
  };
}

/**
 * فحص replay علني ضيق يسبق Turnstile أحادي الاستعمال. يعيد نجاحاً فقط بعد مطابقة الهاتف
 * والمحافظة والعنوان والبنود؛ اصطدام مفتاح لطرف آخر يفشل بلا كشف أي حقل من طلبه.
 */
export async function findOwnedOnlineOrderReplay(
  input: CreateOnlineOrderInput,
): Promise<CreateOnlineOrderResult | null> {
  if (!input.clientRequestId) return null;
  const identity = normalizeOwnedReplayIdentity(input);
  return withTx((tx) => loadOwnedReplay(
    tx,
    input,
    identity.phone,
    identity.requestedShippingAddress,
    identity.requestedLineQuantities,
  ));
}

async function createOnlineOrderAttempt(
  input: CreateOnlineOrderInput,
): Promise<CreateOnlineOrderResult> {
  const {
    normalizedLines,
    name,
    phone,
    requestedLineQuantities,
    requestedShippingAddress,
  } = normalizeOwnedReplayIdentity(input);
  return withTx(async (tx) => {
    // ① replay يسبق حالة المتجر/الفرع: نجاحٌ مُلتزَم سابقاً يبقى قابلاً للإعادة حتى
    // لو أُغلق المتجر أو تغيّر فرع التنفيذ بعده. الاستعلام معزول بهاتف صاحب الطلب؛
    // المفتاح المتصادم لطرف آخر لا يعيد أيّ حقل من طلبه.
    const replay = await loadOwnedReplay(
      tx,
      input,
      phone,
      requestedShippingAddress,
      requestedLineQuantities,
    );
    if (replay) return replay;

    // الطلب الجديد فقط يمرّ ببوابة التشغيل. storeSettings يُقفَل FOR SHARE (٣٠/٨/٢٦ — كان
    // FOR UPDATE فيتسلسل كل طلبات المتجر خلف قفلٍ عالميّ واحد): S يثبّت اختيار الفرع/الفتح
    // طوال الطلب لأن كاتب الإعدادات يأخذ X فيُحجَب، بينما الطلبات المتزامنة تتشارك S بلا انتظار.
    // منع البيع الزائد ليس هنا أصلاً — تتكفّل به أقفال productUnits/المتغيّرات أدناه.
    // ⚠️ غلاف retryOnDup حول createOnlineOrder صار **حاملاً** لهذا التخفيض: التسلسل القديم
    // كان يخفي سباقات إدراجٍ متوازية (قفلا فجوةٍ متوافقان ثم إدراجان ⇒ deadlock حتميّ لعميلين
    // جديدين متزامنين) والغلاف يعيدها بنجاح — لا يُنزَع إلا مع بديلٍ مكافئ.
    // أمّا صفّ branch فيكفيه FOR SHARE لإثبات الوجود والتفعيل، وهو متوافق مع قفل FK المشترك
    // لإدراج فاتورة POS. قفل الفرع X قبل العميل يعكس ترتيب POS (customer→branch FK) ويصنع deadlock.
    const storefrontContext = await requireStorefrontContext(tx, {
      requireOpen: true,
      lock: true,
      branchLock: "share",
    });
    const branchId = storefrontContext.branchId;
    const lockedCoupon = input.couponCode
      ? await lockCouponForSale(tx, { code: input.couponCode, branchId, customerId: null, todayYmd: todayYmdBaghdad() })
      : null;
    const storeSettings = (
      await tx
        .select({
          freeShippingThreshold: storeSettingsTable.freeShippingThreshold,
        })
        .from(storeSettingsTable)
        .where(eq(storeSettingsTable.id, 1))
        .limit(1)
    )[0];

    // ② لقطة تسعير أولية لبناء متطلبات الأقفال. التثبيت المالي الوحيد أدناه يعيد
    // تشغيل المحرك نفسه بقراءة current مقفلة بعد قفل العميل والوحدات.
    const items = await priceOnlineOrderLines(tx, branchId, normalizedLines, { lock: false, coupon: lockedCoupon });
    const requestedBaseByVariant = new Map<number, number>();

    // أول قفل أعمال مشترك بعد تسعير السلة: العميل، اتساقاً مع POS/createSale.
    const customerId = await lockOrCreateOnlineCustomer(tx, phone, name);

    // ترتيب الأقفال العالمي: customer → productUnit → variant/branchStock → order/items.
    // نقفل معنى الكمية قبل الوصفة وATP؛ تعديل العامل المتزامن إمّا يسبقنا فنرفض
    // لقطة السلة القديمة، أو ينتظرنا ثم يرى الطلب النشط ويرفض التعديل.
    const unitIds = Array.from(new Set(items.map((item) => item.productUnitId))).sort((a, b) => a - b);
    const currentUnits = await lockProductUnitsForOnlineAllocation(tx, unitIds);
    const currentFactorByUnit = new Map(currentUnits.map((unit) => [unit.id, unit.conversionFactor]));
    const currentItems = await priceOnlineOrderLines(tx, branchId, normalizedLines, { lock: true, coupon: lockedCoupon });
    requestedBaseByVariant.clear();
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const current = currentItems[index];
      const factor = current
        ? currentFactorByUnit.get(current.productUnitId)
        : undefined;
      if (
        !current || current.productUnitId !== item.productUnitId || factor == null ||
        !money(item.quantity).times(factor).eq(item.baseQuantity)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت أهلية منتج أو وحدة في السلة أثناء الطلب — حدّث السلة وأعد المحاولة",
        });
      }
      item.productId = current.productId;
      item.categoryId = current.categoryId;
      item.variantId = current.variantId;
      item.productName = current.productName;
      item.isBundle = current.isBundle;
      item.baseQuantity = current.baseQuantity;
      item.unitPrice = current.unitPrice;
      item.lineTotal = current.lineTotal;
      item.discountPerUnit = current.discountPerUnit;
      item.couponDiscountPerUnit = current.couponDiscountPerUnit;
      const requestedBase = (requestedBaseByVariant.get(current.variantId) ?? 0) + current.baseQuantity;
      requestedBaseByVariant.set(current.variantId, requestedBase);
    }
    for (let index = 0; index < items.length; index++) {
      const expected = normalizedLines[index]?.expectedUnitPrice;
      if (expected != null && !round2(expected).eq(items[index].unitPrice)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّر سعر أحد المنتجات منذ عرضه — حدّث السلة ووافق على الإجمالي الجديد",
        });
      }
    }

    // ATP واحد للطلب كاملاً. نفكّ البكج إلى مكوّناته ثم نجمع المتطلبات؛ بهذا لا
    // نطرح حجزاً legacy للبكج، ولا يمرّ طلب يجمع بكجاً وصنفه المكوّن فوق ATP نفسه.
    const bundleIds = Array.from(
      new Set(
        items.filter((item) => item.isBundle).map((item) => item.variantId),
      ),
    );
    if (bundleIds.length) {
      // mutex الوصفة: replaceBundleComponents يقفل الصف نفسه قبل فحص الطلبات النشطة.
      await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(inArray(productVariants.id, bundleIds))
        .orderBy(asc(productVariants.id))
        .for("update");
    }
    const recipes = bundleIds.length
      ? await tx
          .select({
            bundleVariantId: bundleComponents.bundleVariantId,
            componentVariantId: bundleComponents.componentVariantId,
            componentBaseQuantity: bundleComponents.componentBaseQuantity,
          })
          .from(bundleComponents)
          .where(inArray(bundleComponents.bundleVariantId, bundleIds))
      : [];
    const recipeByBundle = new Map<
      number,
      Array<{ componentVariantId: number; componentBaseQuantity: number }>
    >();
    for (const row of recipes) {
      const bundleId = Number(row.bundleVariantId);
      const current = recipeByBundle.get(bundleId) ?? [];
      current.push({
        componentVariantId: Number(row.componentVariantId),
        componentBaseQuantity: Number(row.componentBaseQuantity),
      });
      recipeByBundle.set(bundleId, current);
    }
    const stockRequirements = new Map<number, number>();
    for (const [variantId, requestedBase] of Array.from(
      requestedBaseByVariant.entries(),
    )) {
      const item = items.find(
        (candidate) => candidate.variantId === variantId,
      )!;
      if (!item.isBundle) {
        stockRequirements.set(
          variantId,
          (stockRequirements.get(variantId) ?? 0) + requestedBase,
        );
        continue;
      }
      const components = recipeByBundle.get(variantId) ?? [];
      if (!components.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `«${item.productName}» بكج غير مكتمل ولا يمكن طلبه`,
        });
      }
      for (const component of components) {
        const required = requestedBase * component.componentBaseQuantity;
        stockRequirements.set(
          component.componentVariantId,
          (stockRequirements.get(component.componentVariantId) ?? 0) + required,
        );
      }
    }
    const couponDiscount = round2(items.reduce((sum, item) => sum.plus(money(item.couponDiscountPerUnit ?? "0").times(item.quantity)), money(0)));
    if (lockedCoupon && couponDiscount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون لا ينطبق على أصناف السلة" });
    const quoteTotals = await totalOnlineOrderQuote(tx, items, input.governorate, storeSettings?.freeShippingThreshold);
    const subtotal = money(quoteTotals.subtotal);
    const deliveryFee = money(quoteTotals.deliveryFee);
    const total = money(quoteTotals.total);
    if (input.expectedGrandTotal != null && !round2(input.expectedGrandTotal).eq(total)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "تغيّر إجمالي الطلب أو أجرة التوصيل منذ عرضه — حدّث السلة ووافق على الإجمالي الجديد",
      });
    }

    // ③ ترتيب الأقفال العالمي مع POS/createSale: customer → units → variants → active orders/items.
    // لا ندرج رأس الطلب قبل ATP، وبذلك لا يعود create↔dispatch إلى دورة order→variant.
    const stockAvailability = await loadVariantAvailability(
      tx,
      branchId,
      Array.from(stockRequirements.keys()).sort((a, b) => a - b),
      { lock: true },
    );
    // إن كانت محاولة بنفس المفتاح تنتظر mutex ثم التزمت الأولى، فالقراءة القافلة هنا
    // تراها وتعيد نجاحها قبل ATP/الفتح في إعادة retry اللاحقة، بلا كشف لطرف آخر.
    const concurrentReplay = await loadOwnedReplay(
      tx,
      input,
      phone,
      requestedShippingAddress,
      requestedLineQuantities,
      true,
    );
    if (concurrentReplay) return concurrentReplay;
    for (const [variantId, requiredBase] of Array.from(
      stockRequirements.entries(),
    )) {
      const available = stockAvailability.get(variantId);
      if (available?.isService) continue;
      if (
        !available ||
        available.isBundle ||
        requiredBase > available.availableBase
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "لا تتوفر الكمية المطلوبة حالياً بعد احتساب الحجوزات النشطة والطلبات النشطة — حدّث السلة",
        });
      }
    }

    // ④ إنشاء الطلب (PENDING) — رقمٌ مؤقّت فريد ثم ORD-{id} (بلا سباق ترقيم).
    const insOrder = await tx.insert(onlineOrders).values({
      orderNumber: `TMP-${randomUUID()}`,
      customerId,
      branchId,
      subtotal: toDbMoney(subtotal),
      shippingCost: toDbMoney(deliveryFee),
      taxAmount: "0",
      total: toDbMoney(total),
      status: "PENDING",
      shippingAddress: requestedShippingAddress,
      governorate: input.governorate,
      latitude: input.latitude != null ? String(input.latitude) : null,
      longitude: input.longitude != null ? String(input.longitude) : null,
      clientRequestId: input.clientRequestId ?? null,
      couponCode: lockedCoupon?.code ?? null,
      couponDiscount: toDbMoney(couponDiscount),
    });
    const orderId = extractInsertId(insOrder);
    const orderNumber = `ORD-${100000 + orderId}`;
    // تُثبَّت داخل معاملة الإنشاء بساعة MySQL؛ لا يظهر طلب جديد بلا مهلة.
    await tx.execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 24 HOUR)
      WHERE id = ${orderId}
    `);
    await tx
      .update(onlineOrders)
      .set({ orderNumber })
      .where(eq(onlineOrders.id, orderId));
    const persistedExpiry = (
      await tx
        .select({
          reservationExpiryMs: sql<number | null>`ROUND(UNIX_TIMESTAMP(\`onlineOrders\`.\`reservationExpiresAt\`) * 1000)`,
        })
        .from(onlineOrders)
        .where(eq(onlineOrders.id, orderId))
        .limit(1)
    )[0]?.reservationExpiryMs;
    if (persistedExpiry == null) {
      throw new Error("Online order reservation expiry snapshot was not persisted");
    }
    const reservationExpiresAt = new Date(Number(persistedExpiry));

    // ⑤ بنود الطلب (لقطة السعر الخادمي).
    for (const it of items) {
      await tx.insert(onlineOrderItems).values({
        onlineOrderId: orderId,
        variantId: it.variantId,
        productUnitId: it.productUnitId,
        quantity: toDbQty(it.quantity),
        baseQuantity: it.baseQuantity,
        unitPrice: it.unitPrice,
        total: it.lineTotal,
      });
    }

    return {
      orderId,
      orderNumber,
      reservationExpiresAt,
      branchId,
      subtotal: toDbMoney(subtotal),
      deliveryFee: toDbMoney(deliveryFee),
      total: toDbMoney(total),
      itemCount: items.length,
    };
  });
}

export interface OnlineOrderTracking {
  orderNumber: string;
  status: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  governorate: string | null;
  createdAt: Date;
  items: {
    productName: string;
    unitName: string;
    quantity: string;
    unitPrice: string;
    total: string;
  }[];
}

/**
 * تتبّع الطلب: يتطلّب **رقم الطلب + الهاتف معاً** (خصوصية — لا يكفي تخمين الرقم لرؤية طلب غيرك).
 * null إن لم يُطابِق.
 */
export async function trackOnlineOrder(
  orderNumber: string,
  phone: string,
): Promise<OnlineOrderTracking | null> {
  const db = getDb();
  if (!db) return null;
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: onlineOrders.status,
        subtotal: onlineOrders.subtotal,
        shippingCost: onlineOrders.shippingCost,
        total: onlineOrders.total,
        governorate: onlineOrders.governorate,
        createdAt: onlineOrders.createdAt,
        customerPhone: sql<
          string | null
        >`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
      })
      .from(onlineOrders)
      .innerJoin(customers, eq(onlineOrders.customerId, customers.id))
      // الهاتف المخزَّن E.164 (normalizeStorePhone عند الإنشاء) ⇒ نُوحِّد المُدخَل قبل المطابقة،
      // وإلا لم يُطابق زبونٌ يُدخِل رقمه بصيغته المحلّية «0770…» رقمَه المخزَّن «+964770…» أبداً.
      .where(
        and(
          eq(onlineOrders.orderNumber, orderNumber.trim()),
          eq(customers.phone, normalizeStorePhone(phone)),
        ),
      )
      .limit(1)
  )[0];
  if (!order) return null;

  const rows = await db
    .select({
      productName: products.name,
      unitName: productUnits.unitName,
      quantity: onlineOrderItems.quantity,
      unitPrice: onlineOrderItems.unitPrice,
      total: onlineOrderItems.total,
    })
    .from(onlineOrderItems)
    .innerJoin(
      productVariants,
      eq(onlineOrderItems.variantId, productVariants.id),
    )
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(onlineOrderItems.productUnitId, productUnits.id))
    .where(eq(onlineOrderItems.onlineOrderId, Number(order.id)));

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    subtotal: String(order.subtotal),
    deliveryFee: String(order.shippingCost),
    total: String(order.total),
    governorate: order.governorate ?? null,
    createdAt: order.createdAt,
    items: rows.map((r) => ({
      productName: r.productName,
      unitName: r.unitName ?? "",
      quantity: String(r.quantity),
      unitPrice: String(r.unitPrice),
      total: String(r.total),
    })),
  };
}

/**
 * ملخص QR المطبوع على الطرد. لا يكفي رقم الطلب المتسلسل للوصول إليه: يجب أن يطابق
 * التوقيع HMAC الذي أنشأه الخادم للملصق، فتظل قراءة الملصق مفيدة للمندوب وآمنة من التخمين.
 */
export async function readOnlineOrderLabel(
  orderNumber: string,
  token: string,
): Promise<
  OnlineOrderTracking & {
    customerName: string | null;
    customerPhone: string | null;
    addressText: string | null;
  }
> {
  if (!verifyOnlineOrderLabelToken(orderNumber, token)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "رمز الملصق غير صالح" });
  }
  const db = getDb();
  if (!db)
    throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: onlineOrders.status,
        subtotal: onlineOrders.subtotal,
        shippingCost: onlineOrders.shippingCost,
        total: onlineOrders.total,
        governorate: onlineOrders.governorate,
        createdAt: onlineOrders.createdAt,
        customerName: customers.name,
        customerPhone: sql<
          string | null
        >`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
        addressText: onlineOrders.shippingAddress,
      })
      .from(onlineOrders)
      .innerJoin(customers, eq(onlineOrders.customerId, customers.id))
      .where(eq(onlineOrders.orderNumber, orderNumber.trim()))
      .limit(1)
  )[0];
  if (!order)
    throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
  const items = await db
    .select({
      productName: products.name,
      unitName: productUnits.unitName,
      quantity: onlineOrderItems.quantity,
      unitPrice: onlineOrderItems.unitPrice,
      total: onlineOrderItems.total,
    })
    .from(onlineOrderItems)
    .innerJoin(
      productVariants,
      eq(onlineOrderItems.variantId, productVariants.id),
    )
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(onlineOrderItems.productUnitId, productUnits.id))
    .where(eq(onlineOrderItems.onlineOrderId, Number(order.id)));
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    subtotal: String(order.subtotal),
    deliveryFee: String(order.shippingCost),
    total: String(order.total),
    governorate: order.governorate ?? null,
    createdAt: order.createdAt,
    customerName: order.customerName ?? null,
    customerPhone: order.customerPhone ?? null,
    addressText: order.addressText ?? null,
    items: items.map((i) => ({
      productName: i.productName,
      unitName: i.unitName ?? "",
      quantity: String(i.quantity),
      unitPrice: String(i.unitPrice),
      total: String(i.total),
    })),
  };
}
