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
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  bundleComponents,
  categories,
  customers,
  deliveryZones,
  onlineOrderItems,
  onlineOrders,
  productCustomizationFields,
  productCustomizationTemplates,
  productPrices,
  productUnits,
  productVariants,
  products,
  storefrontCustomizationAssets,
  storeSettings as storeSettingsTable,
  type OnlineOrderCustomizationSnapshot,
} from "../../drizzle/schema";
import { appErrorMessage } from "@shared/errors";
import { deliveryFeeFor, governorateById, isBaghdadGovernorate } from "@shared/governorates";
import { previewDeliveryQuote } from "./delivery/pricingRules";
import { getDb, type Tx } from "../db";
import { isCurrentTenantCustomizerKey } from "../lib/imageStore";
import { extractInsertId } from "../lib/insertId";
import { normalizeIraqPhoneE164 } from "../lib/phone";
import { money, round2, sumMoney, toDbMoney, toDbQty } from "./money";
import { nextCounterValue, nextTransactionTrackingNumber } from "./numbering";
import {
  loadPromotionRuleSnapshot,
  resolvePromotionFromSnapshot,
} from "./salesPromotionService";
import { requireStorefrontContext } from "./storefrontContextService";
import { withTx } from "./tx";
import {
  lockCouponForSale,
  normalizeCouponCode,
  releaseCouponReservationForOnlineOrder,
  reserveCouponForOnlineOrder,
  type LockedCoupon,
} from "./couponService";
import { verifyOnlineOrderLabelToken } from "./barcodeService";
import {
  loadVariantAvailability,
  lockProductUnitsForOnlineAllocation,
} from "./catalog/variantAvailability";
import { retryOnDup } from "../lib/retryDup";
import { publishRealtimeEvent } from "../realtime";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";
import { currentOnlineOrderStatus, loadOnlineOrderLifecycles } from "./storeAdmin/onlineOrderTracking";

const RETAIL = "RETAIL" as const;
const WHOLESALE = "WHOLESALE" as const;
/**
 * عقد المتجر: لا يصير سعر الجملة خياراً قابلاً للتلاعب من العميل. يجمع الخادم كل ألوان
 * ووحدات المنتج نفسه بوحدة الأساس، ويستحقه العميل عند اثنتي عشرة قطعة فأكثر فقط.
 */
export const STOREFRONT_WHOLESALE_MINIMUM_BASE_QUANTITY = 12;
const GUEST_TRACKING_TTL_SECONDS = 60 * 60 * 24 * 30;
const GUEST_TRACKING_DOMAIN = "STORE_GUEST_TRACKING_V1";
const MAX_CUSTOMIZATION_VALUE_LENGTH = 10_000;
const MAX_ONLINE_ORDER_MONEY = money("9999999999999.99");

function guestTrackingSecret(): string {
  const secret = process.env.BARCODE_SECRET || (process.env.NODE_ENV !== "production" ? "default_dev_barcode_secret_32_bytes_ok" : undefined);
  if (!secret)
    throw new Error("BARCODE_SECRET غير مُعيَّن لتوقيع تتبّع طلب الضيف");
  return secret;
}

function guestTrackingMac(publicId: string, expiresAtSeconds: number): string {
  return createHmac("sha256", guestTrackingSecret())
    .update(`${GUEST_TRACKING_DOMAIN}|${publicId}|${expiresAtSeconds}`)
    .digest("base64url");
}

function buildGuestTrackingToken(publicId: string, expiresAt: Date): string {
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
  return `${publicId}.${expiresAtSeconds.toString(36)}.${guestTrackingMac(publicId, expiresAtSeconds)}`;
}

function hashGuestTrackingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function parseAndVerifyGuestTrackingToken(token: string): {
  publicId: string;
  tokenHash: string;
  expiresAtSeconds: number;
} | null {
  const normalized = token.trim();
  const [publicId, expiryBase36, receivedMac, extra] = normalized.split(".");
  if (
    extra != null ||
    !/^[a-f0-9]{32}$/.test(publicId ?? "") ||
    !/^[a-z0-9]{1,13}$/.test(expiryBase36 ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(receivedMac ?? "")
  )
    return null;
  const expiresAtSeconds = Number.parseInt(expiryBase36, 36);
  if (
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= Math.floor(Date.now() / 1000)
  )
    return null;
  const expected = Buffer.from(
    guestTrackingMac(publicId, expiresAtSeconds),
    "utf8",
  );
  const received = Buffer.from(receivedMac, "utf8");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return null;
  return {
    publicId,
    tokenHash: hashGuestTrackingToken(normalized),
    expiresAtSeconds,
  };
}

/** حبيبة اليوم المحلي (بغداد UTC+3) YYYY-MM-DD — لتطابق نافذة العروض مع العرض في الكتالوج. */
function todayYmdBaghdad(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface OnlineOrderLineInput {
  productUnitId: number;
  quantity: number;
  customization?: OnlineOrderCustomizationInput | null;
  /** السعر الذي ظهر للزبون عند التأكيد؛ لا يُستعمل للتسعير بل كـoptimistic contract. */
  expectedUnitPrice?: string | null;
}

export interface OnlineOrderCustomizationInput {
  templateId: number;
  values: Record<string, string>;
  logoAssetKey?: string;
  previewAssetKey?: string;
}

export const MAX_ONLINE_ORDER_DISTINCT_UNITS = 30;
export const MAX_ONLINE_ORDER_QUANTITY_PER_UNIT = 999;
export const MAX_ONLINE_ORDER_TOTAL_QUANTITY = 10_000;

function normalizeExpectedUnitPrice(
  value: string | null | undefined,
): string | null | undefined {
  if (value == null) return value;
  try {
    if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(value))
      throw new Error("invalid price shape");
    const parsed = money(value);
    if (
      !parsed.isFinite()
      || parsed.lt(0)
      || parsed.gt(MAX_ONLINE_ORDER_MONEY)
      || parsed.decimalPlaces() > 2
    )
      throw new Error("invalid price");
    return toDbMoney(parsed);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تجهيز سلّتك",
        why: "سعر أحد الأصناف وصل بصيغةٍ لا نقبلها (يجب أن يكون رقماً موجباً بمنزلتين عشريتين على الأكثر)",
        doThis:
          "حدّث الصفحة وأعد إضافة الأصناف إلى السلّة، وإن تكرّر الأمر فتواصل معنا",
      }),
    });
  }
}

function normalizeCustomizationAssetKey(
  rawKey: string | undefined,
  label: string,
): string | undefined {
  if (rawKey == null) return undefined;
  if (typeof rawKey !== "string") {
    throw customizationInputError(
      "BAD_REQUEST",
      "تعذّر تجهيز التخصيص",
      `مرفق ${label} وصل بصيغة غير صالحة`,
      "أعد رفع الصورة من صفحة المنتج ثم حاول مجدداً",
    );
  }
  const trimmed = rawKey.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 255 || !isCurrentTenantCustomizerKey(trimmed)) {
    throw customizationInputError(
      "BAD_REQUEST",
      "تعذّر تجهيز التخصيص",
      `مفتاح مرفق ${label} خارج النطاق المسموح أو بصيغة غير صالحة`,
      "أعد رفع الصورة من صفحة المنتج ثم حاول مجدداً",
    );
  }
  return trimmed;
}

function normalizeCustomizationInput(
  customization: OnlineOrderCustomizationInput | null | undefined,
): OnlineOrderCustomizationInput | undefined {
  if (customization == null) return undefined;
  if (!Number.isSafeInteger(customization.templateId) || customization.templateId <= 0) {
    throw customizationInputError("BAD_REQUEST", "تعذّر تجهيز التخصيص", "معرّف قالب التخصيص غير صالح", "حدّث صفحة المنتج وأدخل التفاصيل مجدداً");
  }
  const entries = Object.entries(customization.values ?? {});
  if (entries.length > 50) {
    throw customizationInputError("BAD_REQUEST", "تعذّر تجهيز التخصيص", "عدد حقول التخصيص تجاوز الحد المسموح", "حدّث صفحة المنتج واستخدم الحقول الظاهرة فقط");
  }
  const values: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const fieldKey = rawKey.trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(fieldKey) || typeof rawValue !== "string" || rawValue.length > MAX_CUSTOMIZATION_VALUE_LENGTH) {
      throw customizationInputError("BAD_REQUEST", "تعذّر تجهيز التخصيص", "أحد حقول التخصيص وصل بصيغة غير صالحة", "حدّث صفحة المنتج وأدخل التفاصيل مجدداً");
    }
    const value = rawValue.trim();
    if (value) values[fieldKey] = value;
  }
  const logoAssetKey = normalizeCustomizationAssetKey(customization.logoAssetKey, "الشعار");
  const previewAssetKey = normalizeCustomizationAssetKey(customization.previewAssetKey, "المعاينة");
  return {
    templateId: customization.templateId,
    values,
    ...(logoAssetKey ? { logoAssetKey } : {}),
    ...(previewAssetKey ? { previewAssetKey } : {}),
  };
}

function customizationIdentity(customization: OnlineOrderCustomizationInput | undefined): string {
  return customization == null ? "" : JSON.stringify(customization);
}

function customizationInputError(
  code: "BAD_REQUEST" | "CONFLICT",
  what: string,
  why: string,
  doThis: string,
): TRPCError {
  return new TRPCError({ code, message: appErrorMessage({ what, why, doThis }) });
}

function onlineOrderLineIdentity(line: Pick<OnlineOrderLineInput, "productUnitId" | "customization">): string {
  return `${line.productUnitId}:${customizationIdentity(line.customization ?? undefined)}`;
}

/**
 * عقد سلة علني موحّد للـquote والإنشاء: يدمج تكرار productUnitId قبل أي SQL، ويبقي كل لون
 * (وحدة/متغيّر مختلف) سطراً مستقلاً. الحدود تُطبّق بعد الدمج كي لا تتجاوزها دفعات مكررة.
 */
export function normalizeOnlineOrderLines(
  lines: ReadonlyArray<
    Pick<
      OnlineOrderLineInput,
      "productUnitId" | "quantity" | "expectedUnitPrice" | "customization"
    >
  >,
): OnlineOrderLineInput[] {
  if (!lines.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إتمام الطلب",
        why: "السلّة فارغة ولا صنف فيها",
        doThis: "أضِف صنفاً واحداً على الأقل من المتجر ثمّ أعد تأكيد الطلب",
      }),
    });
  const normalized: OnlineOrderLineInput[] = [];
  const bySelection = new Map<string, OnlineOrderLineInput>();
  let totalQuantity = 0;

  for (const line of lines) {
    const productUnitId = line.productUnitId;
    const quantity = line.quantity;
    if (
      !Number.isSafeInteger(productUnitId) ||
      productUnitId <= 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تجهيز سلّتك",
          why: "أحد أسطر السلّة وصل بصنفٍ غير معروف أو بكميةٍ ليست عدداً صحيحاً أكبر من 0",
          doThis:
            "احذف الصنف من السلّة وأضِفه من جديد من صفحة المنتج، ثمّ أعد المحاولة",
        }),
      });
    }
    const expectedUnitPrice = normalizeExpectedUnitPrice(
      line.expectedUnitPrice,
    );
    const customization = normalizeCustomizationInput(line.customization);
    const selectionKey = onlineOrderLineIdentity({ productUnitId, customization });
    const current = bySelection.get(selectionKey);
    if (!current) {
      if (bySelection.size >= MAX_ONLINE_ORDER_DISTINCT_UNITS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إتمام الطلب",
            why: `سلّتك تحوي أصنافاً أكثر من الحدّ الأقصى للطلب الواحد (${MAX_ONLINE_ORDER_DISTINCT_UNITS} صنفاً مختلفاً)`,
            doThis:
              "احذف بعض الأصناف وأتمّ هذا الطلب، ثمّ أرسل الباقي في طلبٍ ثانٍ",
          }),
        });
      }
      const added = { productUnitId, quantity, expectedUnitPrice, customization };
      bySelection.set(selectionKey, added);
      normalized.push(added);
    } else {
      if (
        current.expectedUnitPrice != null &&
        expectedUnitPrice != null &&
        !money(current.expectedUnitPrice).eq(money(expectedUnitPrice))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إتمام الطلب",
            why: `الصنف نفسه موجودٌ في سلّتك بسعرين مختلفين (${current.expectedUnitPrice} و${expectedUnitPrice} د.ع)، فلا ندري أيّهما وافقتَ عليه`,
            doThis:
              "حدّث الصفحة لتظهر الأسعار الحالية، ثمّ راجع السلّة وأعد تأكيد الطلب",
          }),
        });
      }
      current.quantity += quantity;
      if (current.expectedUnitPrice == null && expectedUnitPrice != null) {
        current.expectedUnitPrice = expectedUnitPrice;
      }
    }
    const mergedQuantity = bySelection.get(selectionKey)!.quantity;
    if (mergedQuantity > MAX_ONLINE_ORDER_QUANTITY_PER_UNIT) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إتمام الطلب",
          why: `طلبتَ ${mergedQuantity} قطعة من صنفٍ واحد، والحدّ الأقصى للصنف الواحد ${MAX_ONLINE_ORDER_QUANTITY_PER_UNIT} قطعة في الطلب`,
          doThis: `أنقص الكمية إلى ${MAX_ONLINE_ORDER_QUANTITY_PER_UNIT} أو أقلّ، أو تواصل معنا لطلبٍ بالجملة`,
        }),
      });
    }
    totalQuantity += quantity;
    if (totalQuantity > MAX_ONLINE_ORDER_TOTAL_QUANTITY) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إتمام الطلب",
          why: `مجموع كميات سلّتك ${totalQuantity} قطعة، والحدّ الأقصى للطلب الواحد ${MAX_ONLINE_ORDER_TOTAL_QUANTITY} قطعة`,
          doThis: "وزّع الكميات على أكثر من طلب، أو تواصل معنا لطلبٍ بالجملة",
        }),
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
  /** هوية موثّقة يحقنها الراوتر بعد Firebase؛ لا يقبلها عقد العميل مباشرة. */
  authenticatedCustomer?: { customerId: number; phone: string } | null;
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
  deliveryFree: boolean;
  deliveryWaivedAmount: string;
  total: string;
  itemCount: number;
  /** رمز opaque قصير العمر؛ null فقط لطلب إرثي أُنشئ قبل الهجرة. */
  guestTrackingToken: string | null;
  guestTrackingExpiresAt: Date | null;
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

const REQUEST_KEY_CONFLICT = appErrorMessage({
  what: "تعذّر إتمام الطلب",
  why: "رمز هذا الطلب مستعمَلٌ لطلبٍ آخر، ولا نكشف تفاصيله حمايةً لخصوصية صاحبه",
  doThis: "حدّث الصفحة ليُولَّد رمز طلبٍ جديد، ثمّ أعد تأكيد سلّتك",
});

/**
 * إعادة idempotent معزولة عن صاحبها. القراءة القافلة تُستعمل بعد variant mutex كي ترى
 * Current Read لطلبٍ التزم بينما كانت هذه المعاملة تنتظر، حتى تحت REPEATABLE READ.
 */
async function loadOwnedReplay(
  tx: Tx,
  input: CreateOnlineOrderInput,
  phone: string,
  requestedShippingAddress: string,
  requestedLineQuantities: ReadonlyMap<string, number>,
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
      deliveryFree: onlineOrders.deliveryFree,
      deliveryWaivedAmount: onlineOrders.deliveryWaivedAmount,
      governorate: onlineOrders.governorate,
      shippingAddress: onlineOrders.shippingAddress,
      guestTrackingPublicId: onlineOrders.guestTrackingPublicId,
      guestTrackingTokenHash: onlineOrders.guestTrackingTokenHash,
      guestTrackingExpiresAt: onlineOrders.guestTrackingExpiresAt,
      reservationExpiryMs: sql<
        number | null
      >`ROUND(UNIX_TIMESTAMP(COALESCE(\`onlineOrders\`.\`reservationExpiresAt\`, DATE_ADD(\`onlineOrders\`.\`orderDate\`, INTERVAL 24 HOUR))) * 1000)`,
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
  const ownerPhones = owner
    ? [owner.phone, owner.phone2, owner.phone3, owner.whatsapp]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map(normalizeStorePhone)
    : [];
  if (!owner || !ownerPhones.includes(phone)) {
    // لا نُفصح هل المفتاح موجود ولا رقم الطلب ولا المبلغ للطرف الآخر.
    throw new TRPCError({ code: "CONFLICT", message: REQUEST_KEY_CONFLICT });
  }
  if (
    input.authenticatedCustomer != null &&
    Number(existing.customerId) !== input.authenticatedCustomer.customerId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر عرض هذا الطلب",
        why: "الطلب مسجَّلٌ على حسابٍ غير الحساب الذي سجّلتَ الدخول به",
        doThis:
          "سجّل الدخول بالحساب صاحب الطلب، أو تواصل معنا ومعك رقم الطلب للتحقّق",
      }),
    });
  }

  const linesQuery = tx
    .select({
      productUnitId: onlineOrderItems.productUnitId,
      quantity: onlineOrderItems.quantity,
      customizationSnapshot: onlineOrderItems.customizationSnapshot,
    })
    .from(onlineOrderItems)
    .where(eq(onlineOrderItems.onlineOrderId, Number(existing.id)));
  const existingLines = lock
    ? await linesQuery.for("update")
    : await linesQuery;
  const storedLineQuantities = new Map<string, number>();
  for (const line of existingLines) {
    const unitId = Number(line.productUnitId);
    const storedCustomization = line.customizationSnapshot == null ? undefined : normalizeCustomizationInput({
      templateId: line.customizationSnapshot.templateId,
      values: Object.fromEntries(line.customizationSnapshot.values.map((value) => [value.fieldKey, value.value])),
      logoAssetKey: line.customizationSnapshot.logoAssetKey,
      previewAssetKey: line.customizationSnapshot.previewAssetKey,
    });
    const identity = onlineOrderLineIdentity({ productUnitId: unitId, customization: storedCustomization });
    storedLineQuantities.set(
      identity,
      (storedLineQuantities.get(identity) ?? 0) + Number(line.quantity),
    );
  }
  const sameLines =
    storedLineQuantities.size === requestedLineQuantities.size &&
    Array.from(requestedLineQuantities.entries()).every(
      ([identity, quantity]) => storedLineQuantities.get(identity) === quantity,
    );
  const requestedCouponCode = input.couponCode
    ? normalizeCouponCode(input.couponCode)
    : null;
  const existingCouponCode = existing.couponCode
    ? normalizeCouponCode(existing.couponCode)
    : null;
  if (
    existing.governorate !== input.governorate ||
    existing.shippingAddress !== requestedShippingAddress ||
    existingCouponCode !== requestedCouponCode ||
    !sameLines
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر إتمام الطلب",
        why: "رمز هذا الطلب مسجَّلٌ لطلبٍ سابق يختلف عن سلّتك الآن في الأصناف أو العنوان أو الكوبون",
        doThis:
          "حدّث الصفحة ليُولَّد رمز طلبٍ جديد، ثمّ أعد تأكيد السلّة الحالية",
      }),
    });
  }
  let guestTrackingToken: string | null = null;
  if (
    existing.guestTrackingPublicId &&
    existing.guestTrackingTokenHash &&
    existing.guestTrackingExpiresAt
  ) {
    const rebuilt = buildGuestTrackingToken(
      existing.guestTrackingPublicId,
      existing.guestTrackingExpiresAt,
    );
    if (hashGuestTrackingToken(rebuilt) !== existing.guestTrackingTokenHash) {
      throw new Error(
        "Online order guest tracking token snapshot is inconsistent",
      );
    }
    guestTrackingToken = rebuilt;
  }
  return {
    orderId: Number(existing.id),
    orderNumber: existing.orderNumber,
    reservationExpiresAt:
      existing.reservationExpiryMs != null
        ? new Date(Number(existing.reservationExpiryMs))
        : (() => {
            throw new Error(
              "Existing online order is missing its reservation expiry snapshot",
            );
          })(),
    branchId: Number(existing.branchId),
    subtotal: String(existing.subtotal),
    deliveryFee: String(existing.shippingCost),
    deliveryFree: existing.deliveryFree === true,
    deliveryWaivedAmount: String(existing.deliveryWaivedAmount ?? "0"),
    total: String(existing.total),
    itemCount: existingLines.length,
    guestTrackingToken,
    guestTrackingExpiresAt: existing.guestTrackingExpiresAt ?? null,
    idempotentReplay: true,
  };
}

/** قفل العميل هو أول قفل أعمال مشترك، قبل المخزون، اتساقاً مع createSale/POS. */
export async function lockOrCreateOnlineCustomer(
  tx: Tx,
  phone: string,
  name: string,
  authenticatedCustomer?: { customerId: number; phone: string } | null,
): Promise<number> {
  if (authenticatedCustomer != null) {
    // الجلسة الموقعة تحمل customerId؛ هذا هو مفتاح الملكية، لا customers.phone وحده. نقفل الصف
    // نفسه ثم نعيد التحقق من أن الهاتف المطلوب واحدٌ من هواتفه canonical الحالية، كي تعمل
    // phone2/phone3/whatsapp ولا ينشأ عميل جديد بالرقم الثانوي.
    const existing = (
      await tx
        .select({
          id: customers.id,
          isActive: customers.isActive,
          phone: customers.phone,
          phone2: customers.phone2,
          phone3: customers.phone3,
          whatsapp: customers.whatsapp,
        })
        .from(customers)
        .where(eq(customers.id, authenticatedCustomer.customerId))
        .for("update")
        .limit(1)
    )[0];
    const verifiedPhones = existing
      ? [existing.phone, existing.phone2, existing.phone3, existing.whatsapp]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          .map(normalizeStorePhone)
      : [];
    if (
      !existing ||
      existing.isActive !== true ||
      !verifiedPhones.includes(phone)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر إتمام الطلب",
          why: "رقم الهاتف المُدخَل ليس من أرقام الحساب الذي سجّلتَ الدخول به، أو أنّ الحساب موقوف",
          doThis:
            "أدخِل رقم هاتفٍ مسجَّلاً في حسابك، أو سجّل الخروج وأكمِل الطلب كضيف، أو تواصل معنا",
        }),
      });
    }
    return Number(existing.id);
  }

  const custLock = `online-customer:${phone}`;
  const lockRes = (await tx.execute(
    sql`SELECT GET_LOCK(${custLock}, 5) AS locked`,
  )) as unknown;
  const lockedRow = Array.isArray(lockRes)
    ? (lockRes[0] as { locked?: number }[])?.[0]
    : (lockRes as { rows?: { locked?: number }[] })?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر إتمام الطلب الآن",
        why: "ضغطٌ مؤقّت على النظام منع تثبيت بيانات حسابك، ولم يُسجَّل أيّ طلب ولم يُخصم شيء",
        doThis:
          "انتظر لحظاتٍ ثمّ اضغط «تأكيد الطلب» مجدداً، وإن تكرّر فتواصل معنا",
      }),
    });
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

export interface PricedOnlineOrderLine {
  productId: number;
  categoryId: number | null;
  variantId: number;
  productName: string;
  isBundle: boolean;
  productUnitId: number;
  quantity: number;
  baseQuantity: number;
  retailUnitPrice: string;
  customizationPriceDelta: string;
  customizationSnapshot: OnlineOrderCustomizationSnapshot | null;
  discountPerUnit: string;
  unitPrice: string;
  lineTotal: string;
  couponDiscountPerUnit?: string;
}

function customizationDependencyMatches(
  dependency: { fieldKey: string; operator: "equals" | "notEquals"; value: string | string[] } | null,
  values: Record<string, string>,
): boolean {
  if (!dependency) return true;
  const expected = Array.isArray(dependency.value) ? dependency.value : [dependency.value];
  const matches = expected.includes(values[dependency.fieldKey] ?? "");
  return dependency.operator === "notEquals" ? !matches : matches;
}

function visibleCustomizationFieldKeys(
  fields: ReadonlyArray<{ fieldKey: string; dependency: { fieldKey: string; operator: "equals" | "notEquals"; value: string | string[] } | null }>,
  values: Record<string, string>,
): Set<string> {
  const byKey = new Map(fields.map((field) => [field.fieldKey, field]));
  const resolved = new Map<string, boolean>();
  const resolving = new Set<string>();
  const isVisible = (fieldKey: string): boolean => {
    if (resolved.has(fieldKey)) return resolved.get(fieldKey)!;
    const field = byKey.get(fieldKey);
    if (!field || resolving.has(fieldKey)) return false;
    resolving.add(fieldKey);
    const visible = field.dependency == null || (isVisible(field.dependency.fieldKey) && customizationDependencyMatches(field.dependency, values));
    resolving.delete(fieldKey);
    resolved.set(fieldKey, visible);
    return visible;
  };
  return new Set(fields.filter((field) => isVisible(field.fieldKey)).map((field) => field.fieldKey));
}

function validCustomizationPriceDelta(value: unknown): boolean {
  return /^\d{1,13}(?:\.\d{1,2})?$/.test(String(value ?? "0").trim());
}

type BatchedCustomizationTemplate = {
  id: number;
  productId: number;
  kind: "PRINT" | "GIFT" | "GENERAL";
  title: string;
};

type BatchedCustomizationField = {
  templateId: number;
  fieldKey: string;
  label: string;
  fieldType: typeof productCustomizationFields.$inferSelect["fieldType"];
  isRequired: boolean;
  maxLength: number | null;
  options: typeof productCustomizationFields.$inferSelect["optionsJson"];
  dependency: typeof productCustomizationFields.$inferSelect["dependencyJson"];
  priceDelta: string | null;
};

type BatchedCustomizationAsset = {
  assetKey: string;
  kind: "LOGO" | "PREVIEW";
};

type OnlineOrderCustomizationBatch = {
  templatesById: ReadonlyMap<number, BatchedCustomizationTemplate>;
  fieldsByTemplateId: ReadonlyMap<number, ReadonlyArray<BatchedCustomizationField>>;
  assetsByKey: ReadonlyMap<string, BatchedCustomizationAsset>;
};

async function loadOnlineOrderCustomizationBatch(
  tx: Tx,
  lines: ReadonlyArray<Pick<OnlineOrderLineInput, "customization">>,
): Promise<OnlineOrderCustomizationBatch> {
  const templateIds = Array.from(
    new Set(
      lines.flatMap((line) =>
        line.customization != null && Number.isSafeInteger(line.customization.templateId) && line.customization.templateId > 0
          ? [Number(line.customization.templateId)]
          : [],
      ),
    ),
  ).sort((a, b) => a - b);

  const assetKeys = Array.from(
    new Set(
      lines.flatMap((line) => {
        if (!line.customization) return [];
        const keys: string[] = [];
        const logoKey = normalizeCustomizationAssetKey(line.customization.logoAssetKey, "الشعار");
        const previewKey = normalizeCustomizationAssetKey(line.customization.previewAssetKey, "المعاينة");
        if (logoKey) keys.push(logoKey);
        if (previewKey) keys.push(previewKey);
        return keys;
      }),
    ),
  ).sort();

  const templateRows = templateIds.length
    ? await tx
        .select({
          id: productCustomizationTemplates.id,
          productId: productCustomizationTemplates.productId,
          kind: productCustomizationTemplates.kind,
          title: productCustomizationTemplates.title,
        })
        .from(productCustomizationTemplates)
        .where(
          and(
            inArray(productCustomizationTemplates.id, templateIds),
            eq(productCustomizationTemplates.isActive, true),
          ),
        )
    : [];

  const templatesById = new Map<number, BatchedCustomizationTemplate>();
  for (const row of templateRows) {
    templatesById.set(Number(row.id), {
      id: Number(row.id),
      productId: Number(row.productId),
      kind: row.kind,
      title: row.title,
    });
  }

  const activeTemplateIds = Array.from(templatesById.keys()).sort((a, b) => a - b);
  const fieldRows = activeTemplateIds.length
    ? await tx
        .select({
          templateId: productCustomizationFields.templateId,
          fieldKey: productCustomizationFields.fieldKey,
          label: productCustomizationFields.label,
          fieldType: productCustomizationFields.fieldType,
          isRequired: productCustomizationFields.isRequired,
          maxLength: productCustomizationFields.maxLength,
          options: productCustomizationFields.optionsJson,
          dependency: productCustomizationFields.dependencyJson,
          priceDelta: productCustomizationFields.priceDelta,
        })
        .from(productCustomizationFields)
        .where(
          and(
            inArray(productCustomizationFields.templateId, activeTemplateIds),
            eq(productCustomizationFields.isActive, true),
          ),
        )
        .orderBy(
          asc(productCustomizationFields.templateId),
          asc(productCustomizationFields.sortOrder),
          asc(productCustomizationFields.id),
        )
    : [];

  const fieldsByTemplateId = new Map<number, BatchedCustomizationField[]>();
  for (const row of fieldRows) {
    const templateId = Number(row.templateId);
    const list = fieldsByTemplateId.get(templateId) ?? [];
    list.push({
      templateId,
      fieldKey: row.fieldKey,
      label: row.label,
      fieldType: row.fieldType,
      isRequired: row.isRequired,
      maxLength: row.maxLength,
      options: row.options,
      dependency: row.dependency,
      priceDelta: row.priceDelta,
    });
    fieldsByTemplateId.set(templateId, list);
  }

  const assetRows = assetKeys.length
    ? await tx
        .select({
          assetKey: storefrontCustomizationAssets.assetKey,
          kind: storefrontCustomizationAssets.kind,
        })
        .from(storefrontCustomizationAssets)
        .where(
          and(
            inArray(storefrontCustomizationAssets.assetKey, assetKeys),
            or(
              isNull(storefrontCustomizationAssets.expiresAt),
              sql`${storefrontCustomizationAssets.expiresAt} > CURRENT_TIMESTAMP`,
            )!,
          ),
        )
    : [];

  const assetsByKey = new Map<string, BatchedCustomizationAsset>();
  for (const row of assetRows) {
    if (isCurrentTenantCustomizerKey(row.assetKey)) {
      assetsByKey.set(row.assetKey, { assetKey: row.assetKey, kind: row.kind });
    }
  }

  return { templatesById, fieldsByTemplateId, assetsByKey };
}

function resolveOnlineOrderCustomizationFromBatch(
  product: {
    productId: number;
    productName: string;
    productType: string | null;
    isCustomizable: boolean | null;
  },
  customization: OnlineOrderCustomizationInput | null | undefined,
  batch: OnlineOrderCustomizationBatch,
  options?: { allowWithoutCustomization?: boolean },
): { snapshot: OnlineOrderCustomizationSnapshot | null; priceDelta: ReturnType<typeof money> } {
  if (product.isCustomizable !== true) {
    if (customization != null) {
      throw customizationInputError("BAD_REQUEST", `تعذّر تخصيص «${product.productName}»`, "هذا الصنف غير مهيأ لاستقبال تفاصيل تخصيص", "احذف تفاصيل التخصيص أو افتح المنتج الصحيح من المتجر");
    }
    return { snapshot: null, priceDelta: money(0) };
  }
  if (customization == null) {
    if (options?.allowWithoutCustomization) {
      return { snapshot: null, priceDelta: money(0) };
    }
    throw customizationInputError("BAD_REQUEST", `تفاصيل «${product.productName}» ناقصة`, "الصنف قابل للتخصيص ولم تصل معه تفاصيل الزبون", "افتح صفحة المنتج وأكمل حقول التخصيص قبل إضافته إلى الطلب");
  }
  const candidateTemplate = batch.templatesById.get(Number(customization.templateId));
  const template =
    candidateTemplate && candidateTemplate.productId === product.productId
      ? candidateTemplate
      : undefined;
  if (!template) {
    throw customizationInputError("CONFLICT", `تغيّر تخصيص «${product.productName}»`, "قالب التخصيص الذي استُعمل في السلة لم يعد القالب النشط", "حدّث صفحة المنتج وأدخل التفاصيل في الحقول الحالية ثم أعد التأكيد");
  }
  const expectedKind = product.productType === "PRINT_SERVICE" ? "PRINT" : "GIFT";
  if (template.kind !== "GENERAL" && template.kind !== expectedKind) {
    throw customizationInputError(
      "CONFLICT",
      `تغيّر تخصيص «${product.productName}»`,
      "نوع قالب التخصيص لا يطابق نوع المنتج الحالي",
      "حدّث صفحة المنتج، وإن بقيت المشكلة فتواصل معنا لتصحيح إعداد القالب",
    );
  }

  const logoAssetKey = normalizeCustomizationAssetKey(customization.logoAssetKey, "الشعار");
  if (logoAssetKey) {
    const asset = batch.assetsByKey.get(logoAssetKey);
    if (!asset || asset.kind !== "LOGO") {
      throw customizationInputError(
        "BAD_REQUEST",
        `تعذّر إرفاق شعار «${product.productName}»`,
        "مرفق الشعار غير موجود أو لا يطابق نوع الشعار المطلوب",
        "أعد رفع ملف الشعار من صفحة المنتج ثم أعد المحاولة",
      );
    }
  }

  const previewAssetKey = normalizeCustomizationAssetKey(customization.previewAssetKey, "المعاينة");
  if (previewAssetKey) {
    const asset = batch.assetsByKey.get(previewAssetKey);
    if (!asset || asset.kind !== "PREVIEW") {
      throw customizationInputError(
        "BAD_REQUEST",
        `تعذّر إرفاق معاينة «${product.productName}»`,
        "مرفق المعاينة غير موجود أو لا يطابق نوع المعاينة المطلوب",
        "أعد رفع صورة المعاينة من صفحة المنتج ثم أعد المحاولة",
      );
    }
  }

  const fields = batch.fieldsByTemplateId.get(template.id) ?? [];
  const knownKeys = new Set(fields.map((field) => field.fieldKey));
  if (Object.entries(customization.values).some(([key, value]) => value !== "" && !knownKeys.has(key))) {
    throw customizationInputError("BAD_REQUEST", `تعذّر تخصيص «${product.productName}»`, "وصل حقل تخصيص غير موجود في القالب الحالي", "حدّث صفحة المنتج وأدخل التفاصيل في الحقول الظاهرة فقط");
  }
  const visibleFieldKeys = visibleCustomizationFieldKeys(fields, customization.values);
  const hiddenSubmittedField = fields.find((field) =>
    Boolean((customization.values[field.fieldKey] ?? "").trim())
    && !visibleFieldKeys.has(field.fieldKey));
  if (hiddenSubmittedField) {
    throw customizationInputError(
      "BAD_REQUEST",
      `تعذّر تخصيص «${product.productName}»`,
      `وصلت قيمة لحقل «${hiddenSubmittedField.label}» رغم أن شرط ظهوره غير متحقق`,
      "حدّث صفحة المنتج وأدخل التفاصيل في الحقول الظاهرة فقط",
    );
  }
  let priceDelta = money(0);
  const values: OnlineOrderCustomizationSnapshot["values"] = [];
  for (const field of fields) {
    if (!visibleFieldKeys.has(field.fieldKey)) continue;
    const value = (customization.values[field.fieldKey] ?? "").trim();
    if (field.isRequired && !value) {
      throw customizationInputError("BAD_REQUEST", `حقل «${field.label}» مطلوب`, `تفاصيل تخصيص «${product.productName}» لم تتضمن هذا الحقل الإلزامي`, "أكمل الحقل في صفحة المنتج ثم أعد إضافة الصنف");
    }
    if (!value) continue;
    if (value.length > (field.maxLength ?? 2_000)) {
      throw customizationInputError("BAD_REQUEST", `قيمة «${field.label}» طويلة`, "النص المدخل تجاوز الحد المضبوط لهذا الحقل", "اختصر النص إلى الحد الظاهر في الحقل ثم أعد المحاولة");
    }
    const optionsList = field.options ?? [];
    const selectedOption = optionsList.find((option) => option.value === value);
    if ((field.fieldType === "SELECT" || field.fieldType === "SWATCH") && !selectedOption) {
      throw customizationInputError("BAD_REQUEST", `خيار «${field.label}» غير صالح`, "القيمة المرسلة ليست من خيارات القالب الحالي", "حدّث صفحة المنتج واختر قيمة من القائمة الظاهرة");
    }
    if (field.fieldType === "NUMBER" && (!Number.isFinite(Number(value)) || value.length > 40)) {
      throw customizationInputError("BAD_REQUEST", `قيمة «${field.label}» غير صالحة`, "هذا الحقل يقبل رقماً فقط", "اكتب رقماً صالحاً في الحقل ثم أعد المحاولة");
    }
    if (!validCustomizationPriceDelta(field.priceDelta) || !validCustomizationPriceDelta(selectedOption?.priceDelta)) {
      throw customizationInputError(
        "CONFLICT",
        `تعذّر تسعير تخصيص «${product.productName}»`,
        "إعداد فرق السعر في قالب التخصيص غير صالح",
        "تواصل معنا لتصحيح أسعار خيارات التخصيص قبل إتمام الطلب",
      );
    }
    const fieldDelta = money(field.priceDelta ?? 0);
    const optionDelta = money(selectedOption?.priceDelta ?? 0);
    priceDelta = priceDelta.plus(fieldDelta).plus(optionDelta);
    if (!priceDelta.isFinite() || priceDelta.gt(MAX_ONLINE_ORDER_MONEY)) {
      throw customizationInputError(
        "CONFLICT",
        `تعذّر تسعير تخصيص «${product.productName}»`,
        "مجموع فروق أسعار القالب تجاوز السعة المالية المسموحة",
        "تواصل معنا لتصحيح أسعار خيارات التخصيص قبل إتمام الطلب",
      );
    }
    values.push({
      fieldKey: field.fieldKey,
      label: field.label,
      value,
      displayValue: selectedOption?.label ?? value,
    });
  }
  const roundedDelta = round2(priceDelta);
  return {
    snapshot: {
      templateId: Number(template.id),
      kind: template.kind,
      title: template.title,
      values,
      unitPriceDelta: roundedDelta.toFixed(2),
      ...(logoAssetKey ? { logoAssetKey } : {}),
      ...(previewAssetKey ? { previewAssetKey } : {}),
    },
    priceDelta: roundedDelta,
  };
}

export type StorefrontPricingBenefitType =
  | "NONE"
  | "WHOLESALE"
  | "OFFER"
  | "COUPON";

export interface OnlineOrderDeliveryContext {
  actualDeliveryFee: import("decimal.js").default;
  freeShippingThreshold: import("decimal.js").default | null;
}

export interface StorefrontPricingBenefit {
  type: StorefrontPricingBenefitType;
  label: string | null;
  discount: string;
  /** الكوبون صالح للسلة لكنه خسر أمام منفعة أعلى، فلا نحجزه ولا نستهلكه. */
  couponSuperseded: boolean;
  /** ميزة الشحن المجاني للكوبون مفعلة كفائز */
  couponShippingActive: boolean;
}

export interface PricedOnlineOrderLines {
  items: PricedOnlineOrderLine[];
  benefit: StorefrontPricingBenefit;
  /**
   * إرشاد قراءةٍ فقط للسلة: يُظهر ما بقي من وحدة الأساس للوصول إلى الجملة،
   * ويجمع ألوان ووحدات المنتج نفسه كما يفعل محرّك التسعير.
   */
  wholesaleProgress: StorefrontWholesaleProgress[];
  /** يختلف عن benefit.discount: يستخدم فقط للتحقق من أن الكوبون يدخل السلة فعلاً. */
  couponCandidateDiscount: string;
}

export interface StorefrontWholesaleProgress {
  productId: number;
  productName: string;
  currentBaseQuantity: number;
  minimumBaseQuantity: number;
  remainingBaseQuantity: number;
}

export interface OnlineOrderQuoteInput {
  couponCode?: string | null;
  governorate: string;
  lines: Array<Pick<OnlineOrderLineInput, "productUnitId" | "quantity" | "customization">>;
  /** يحقنها الراوتر بعد تحقق جلسة Firebase؛ تمكّن القسائم الشخصية وحدّ العميل. */
  authenticatedCustomer?: { customerId: number; phone: string } | null;
}

export interface OnlineOrderQuoteResult {
  couponCode: string | null;
  couponProgramName: string | null;
  couponDiscount: string;
  pricingBenefitType: StorefrontPricingBenefitType;
  pricingBenefitLabel: string | null;
  pricingBenefitDiscount: string;
  couponSuperseded: boolean;
  /** منتجات قريبة من حدّ الجملة وتملك سعراً مخفضاً فعلياً للجملة. */
  wholesaleProgress: StorefrontWholesaleProgress[];
  lines: Array<{
    productUnitId: number;
    quantity: number;
    customization: OnlineOrderCustomizationSnapshot | null;
    retailUnitPrice: string;
    discountPerUnit: string;
    couponDiscountPerUnit: string;
    unitPrice: string;
    lineTotal: string;
  }>;
  /** قيمة المنتجات قبل منفعة السعر الواحدة؛ للعرض الشفاف فقط. */
  retailSubtotal: string;
  subtotal: string;
  deliveryFee: string;
  deliveryFree: boolean;
  deliveryWaivedAmount: string;
  couponDeliveryWaivedAmount: string;
  couponShippingApplied: boolean;
  /** العتبة التي فعّلتها الإدارة الآن؛ null يعني أن حافز التوصيل المجاني غير مفعّل. */
  freeShippingThreshold: string | null;
  /** ما ينقص من قيمة المنتجات لبلوغ العتبة؛ null عندما لا تكون هناك عتبة مفعّلة. */
  freeShippingRemaining: string | null;
  total: string;
}

/** محرك التسعير الوحيد للـquote وللتثبيت؛ يحمّل القوالب والعروض والكوبون دفعةً واحدة خارج حلقة الأسطر. */
export async function priceOnlineOrderLines(
  tx: Tx,
  branchId: number,
  lines: Array<Pick<OnlineOrderLineInput, "productUnitId" | "quantity" | "customization">>,
  options: {
    lock: boolean;
    coupon?: LockedCoupon | null;
    deliveryContext?: OnlineOrderDeliveryContext | null;
    allowStaffCatalogUnits?: boolean;
  },
): Promise<PricedOnlineOrderLines> {
  const unitIds = Array.from(
    new Set(lines.map((line) => Number(line.productUnitId))),
  ).sort((a, b) => a - b);
  const wholesalePrices = alias(productPrices, "storefrontWholesalePrices");
  const query = tx
    .select({
      productId: products.id,
      productName: products.name,
      productType: products.productType,
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
      isCustomizable: products.isCustomizable,
      price: productPrices.price,
      wholesalePrice: wholesalePrices.price,
    })
    .from(productUnits)
    .innerJoin(productVariants, eq(productUnits.variantId, productVariants.id))
    .innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(
      productPrices,
      and(
        eq(productPrices.productUnitId, productUnits.id),
        eq(productPrices.priceTier, RETAIL),
      ),
    )
    .leftJoin(
      wholesalePrices,
      and(
        eq(wholesalePrices.productUnitId, productUnits.id),
        eq(wholesalePrices.priceTier, WHOLESALE),
      ),
    )
    .where(inArray(productUnits.id, unitIds))
    .orderBy(asc(productUnits.id));
  const rows = options.lock ? await query.for("update") : await query;
  const byUnit = new Map(rows.map((row) => [Number(row.productUnitId), row]));
  const todayYmd = todayYmdBaghdad();

  const customizationBatch = await loadOnlineOrderCustomizationBatch(tx, lines);
  const autoPromoSnapshot = await loadPromotionRuleSnapshot(tx, {
    branchId,
    customerTier: RETAIL,
    todayYmd,
    includeStoreManaged: true,
    requiredApplicationMode: "AUTO",
    lockForUpdate: options.lock,
  });
  const couponPromoSnapshot = options.coupon
    ? await loadPromotionRuleSnapshot(tx, {
        branchId,
        customerTier: RETAIL,
        todayYmd,
        includeStoreManaged: true,
        requiredApplicationMode: "COUPON",
        specificPromotionId: options.coupon.promotionId,
        lockForUpdate: options.lock,
      })
    : null;

  const candidates: Array<
    PricedOnlineOrderLine & {
      baseRetailUnitPrice: string;
      automaticDiscountPerUnit: string;
      automaticPromotionName: string | null;
      couponDiscountCandidatePerUnit: string;
      wholesaleUnitPrice: string | null;
    }
  > = [];
  for (const line of lines) {
    const quantity = Math.floor(line.quantity);
    const row = byUnit.get(Number(line.productUnitId));
    const storefrontVisibilityFailed =
      !options.allowStaffCatalogUnits &&
      (!row?.showInStore ||
        (row.categoryId != null &&
          (!row.categoryActive || !row.categoryShowInStore)) ||
        !row.unitAvailableInStore);
    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !row ||
      !row.productActive ||
      !row.variantActive ||
      !row.unitActive ||
      row.price == null ||
      storefrontVisibilityFailed
    ) {
      throw new TRPCError({
        code: options.lock ? "CONFLICT" : "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر إتمام الطلب",
          why: "أحد أصناف سلّتك لم يعُد متاحاً للبيع في المتجر (أُوقف عرضه أو تغيّرت وحدة بيعه أو رُفع سعره من القائمة)",
          doThis:
            "حدّث الصفحة واحذف الصنف الذي اختفى من سلّتك، أو تواصل معنا لنقترح عليك بديلاً",
        }),
      });
    }
    const resolvedCustomization = resolveOnlineOrderCustomizationFromBatch(
      {
        productId: Number(row.productId),
        productName: row.productName,
        productType: row.productType ?? null,
        isCustomizable: row.isCustomizable,
      },
      line.customization,
      customizationBatch,
      { allowWithoutCustomization: options.allowStaffCatalogUnits },
    );
    const base = money(quantity).times(row.conversionFactor ?? 1);
    if (!base.isInteger() || !base.gt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          // ⚠️ **المخرجُ إحالةٌ لا أمرٌ بالتعديل** — أمسكته مراجعةٌ عدائية: `quantity` مضمونٌ
          // **عددٌ صحيحٌ موجب** قبل بلوغ هذا السطر (`normalizeOnlineOrderLines`)، فالسببُ
          // الوحيد الممكن هو `conversionFactor` كسريّ — **عطبُ بياناتٍ عندنا لا خطأٌ من
          // الزبون**. «عدّل الكمية» كانت تُرسله ليُعيد المحاولة فيفشل ثانيةً بلا نهاية.
          what: `تعذّر طلب «${row.productName}» عبر المتجر`,
          why: "بيانات عبوة هذا الصنف غير مضبوطة عندنا، فلا تُحسَب كميّته بدقّة — والخلل من طرفنا لا من طلبك",
          doThis:
            "أكمِل بقيّة طلبك بلا هذا الصنف، وتواصل معنا لنضبطه ونُتمّه لك",
        }),
      });
    }
    const retail = round2(row.price);
    const retailWithCustomization = round2(retail.plus(resolvedCustomization.priceDelta));
    if (!retailWithCustomization.isFinite() || retailWithCustomization.gt(MAX_ONLINE_ORDER_MONEY)) {
      throw customizationInputError(
        "CONFLICT",
        `تعذّر تسعير تخصيص «${row.productName}»`,
        "السعر النهائي بعد التخصيص تجاوز السعة المالية المسموحة",
        "تواصل معنا لتصحيح سعر المنتج أو فروق التخصيص قبل إتمام الطلب",
      );
    }
    const productId = Number(row.productId);
    const variantId = Number(row.variantId);
    const categoryId = row.categoryId == null ? null : Number(row.categoryId);
    const lineAmountStr = retail.times(quantity).toFixed(2);
    const promo = resolvePromotionFromSnapshot(autoPromoSnapshot, {
      branchId,
      customerTier: RETAIL,
      productId,
      variantId,
      categoryId,
      unitPrice: retail.toFixed(2),
      lineAmount: lineAmountStr,
      hasContractPrice: false,
      todayYmd,
      includeStoreManaged: true,
    });
    const automaticDiscount = promo ? money(promo.discountForUnit) : money(0);
    const couponPromo = couponPromoSnapshot && options.coupon
      ? resolvePromotionFromSnapshot(couponPromoSnapshot, {
          branchId,
          customerTier: RETAIL,
          productId,
          variantId,
          categoryId,
          // العروض والكوبونات منفعتان بديلتان في المتجر، لا طبقتا خصم. لذلك يُقاس
          // الكوبون على سعر المفرد الأصلي لا على السعر بعد العرض التلقائي.
          unitPrice: retail.toFixed(2),
          lineAmount: lineAmountStr,
          hasContractPrice: false,
          todayYmd,
          includeStoreManaged: true,
          requiredApplicationMode: "COUPON",
          specificPromotionId: options.coupon.promotionId,
        })
      : null;
    const couponDiscount = couponPromo
      ? money(couponPromo.discountForUnit)
      : money(0);
    candidates.push({
      productId,
      categoryId,
      variantId,
      productName: row.productName,
      isBundle: row.isBundle === true,
      productUnitId: Number(row.productUnitId),
      quantity,
      baseQuantity: base.toNumber(),
      baseRetailUnitPrice: retail.toFixed(2),
      retailUnitPrice: retailWithCustomization.toFixed(2),
      customizationPriceDelta: resolvedCustomization.priceDelta.toFixed(2),
      customizationSnapshot: resolvedCustomization.snapshot,
      automaticDiscountPerUnit: round2(automaticDiscount).toFixed(2),
      automaticPromotionName: promo?.promotionName ?? null,
      couponDiscountCandidatePerUnit: round2(couponDiscount).toFixed(2),
      wholesaleUnitPrice:
        row.wholesalePrice == null ? null : round2(row.wholesalePrice).toFixed(2),
      // تُملأ بعد مقارنة مرشحي الجملة/العرض/الكوبون على مستوى السلة كاملة.
      discountPerUnit: "0.00",
      couponDiscountPerUnit: "0.00",
      unitPrice: retailWithCustomization.toFixed(2),
      lineTotal: round2(retailWithCustomization.times(quantity)).toFixed(2),
    });
  }
  const baseQuantityByProduct = new Map<number, number>();
  for (const item of candidates) {
    baseQuantityByProduct.set(
      item.productId,
      (baseQuantityByProduct.get(item.productId) ?? 0) + item.baseQuantity,
    );
  }
  const wholesaleProgress = Array.from(baseQuantityByProduct.entries())
    .flatMap(([productId, currentBaseQuantity]) => {
      const productItems = candidates.filter(
        (item) => item.productId === productId,
      );
      const hasDiscountedWholesalePrice = productItems.some(
        (item) =>
          item.wholesaleUnitPrice != null &&
          money(item.wholesaleUnitPrice).lt(money(item.baseRetailUnitPrice)),
      );
      if (
        currentBaseQuantity >= STOREFRONT_WHOLESALE_MINIMUM_BASE_QUANTITY ||
        !hasDiscountedWholesalePrice
      ) {
        return [];
      }
      return [{
        productId,
        productName: productItems[0]!.productName,
        currentBaseQuantity,
        minimumBaseQuantity: STOREFRONT_WHOLESALE_MINIMUM_BASE_QUANTITY,
        remainingBaseQuantity:
          STOREFRONT_WHOLESALE_MINIMUM_BASE_QUANTITY - currentBaseQuantity,
      }];
    })
    .sort((left, right) => left.productName.localeCompare(right.productName, "ar"));

  const retailSubtotal = round2(
    candidates.reduce(
      (sum, item) => sum.plus(money(item.retailUnitPrice).times(item.quantity)),
      money(0),
    ),
  );

  const hasMinSpend =
    options.coupon?.minOrderSpend &&
    money(options.coupon.minOrderSpend).gt(0);
  const minSpendSatisfied =
    !hasMinSpend || retailSubtotal.gte(money(options.coupon!.minOrderSpend));

  let wholesaleDiscount = money(0);
  let offerDiscount = money(0);
  let rawCouponMerchandiseDiscount = money(0);
  const offerNames = new Set<string>();
  for (const item of candidates) {
    const parentBaseQuantity = baseQuantityByProduct.get(item.productId) ?? 0;
    const wholesaleDifference = item.wholesaleUnitPrice
      ? money(item.baseRetailUnitPrice).minus(item.wholesaleUnitPrice)
      : money(0);
    const wholesalePerUnit = wholesaleDifference.gt(0)
      ? wholesaleDifference
      : money(0);
    if (parentBaseQuantity >= STOREFRONT_WHOLESALE_MINIMUM_BASE_QUANTITY) {
      wholesaleDiscount = wholesaleDiscount.plus(
        wholesalePerUnit.times(item.quantity),
      );
    }
    const automaticPerUnit = money(item.automaticDiscountPerUnit);
    offerDiscount = offerDiscount.plus(automaticPerUnit.times(item.quantity));
    if (automaticPerUnit.gt(0) && item.automaticPromotionName) {
      offerNames.add(item.automaticPromotionName);
    }
    rawCouponMerchandiseDiscount = rawCouponMerchandiseDiscount.plus(
      money(item.couponDiscountCandidatePerUnit).times(item.quantity),
    );
  }

  const couponMerchandiseDiscount = minSpendSatisfied
    ? rawCouponMerchandiseDiscount
    : money(0);

  let couponShippingWaiver = money(0);
  if (
    options.coupon?.freeShipping &&
    minSpendSatisfied &&
    options.deliveryContext
  ) {
    const { actualDeliveryFee, freeShippingThreshold } = options.deliveryContext;
    const thresholdFree = Boolean(
      freeShippingThreshold &&
      freeShippingThreshold.gt(0) &&
      retailSubtotal.gte(freeShippingThreshold),
    );
    if (!thresholdFree && actualDeliveryFee.gt(0)) {
      couponShippingWaiver = actualDeliveryFee;
    }
  }

  const totalCouponBenefit = couponMerchandiseDiscount.plus(couponShippingWaiver);

  const candidatesByBenefit: Array<{
    type: Exclude<StorefrontPricingBenefitType, "NONE">;
    totalBenefit: ReturnType<typeof money>;
    merchandiseDiscount: ReturnType<typeof money>;
    priority: number;
    label: string;
    shippingActive: boolean;
  }> = [
    // عند التعادل لا نستهلك كوبوناً بلا توفير إضافي؛ تبقى قيمة الكوبون للعميل لاحقاً.
    {
      type: "WHOLESALE" as const,
      totalBenefit: wholesaleDiscount,
      merchandiseDiscount: wholesaleDiscount,
      priority: 3,
      label: "سعر الجملة التلقائي",
      shippingActive: false,
    },
    {
      type: "OFFER" as const,
      totalBenefit: offerDiscount,
      merchandiseDiscount: offerDiscount,
      priority: 2,
      label:
        offerNames.size === 1
          ? Array.from(offerNames)[0]!
          : "أفضل عرض تلقائي",
      shippingActive: false,
    },
    {
      type: "COUPON" as const,
      totalBenefit: totalCouponBenefit,
      merchandiseDiscount: couponMerchandiseDiscount,
      priority: 1,
      label: options.coupon?.programName ?? (couponShippingWaiver.gt(0) ? "توصيل مجاني" : "خصم الكوبون"),
      shippingActive: couponShippingWaiver.gt(0),
    },
  ].filter((candidate) => candidate.totalBenefit.gt(0));
  candidatesByBenefit.sort((a, b) => {
    const compared = b.totalBenefit.comparedTo(a.totalBenefit);
    return compared !== 0 ? compared : b.priority - a.priority;
  });
  const selected = candidatesByBenefit[0];
  if (selected && round2(selected.totalBenefit).gt(MAX_ONLINE_ORDER_MONEY)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسعير الطلب",
        why: "إجمالي المنفعة السعرية تجاوز سعة الطلب الواحد",
        doThis: "قسّم الأصناف على طلبين أو أكثر ثم أعد المحاولة",
      }),
    });
  }
  const benefit: StorefrontPricingBenefit = selected
    ? {
        type: selected.type,
        label: selected.label,
        discount: round2(selected.merchandiseDiscount).toFixed(2),
        couponSuperseded:
          options.coupon != null &&
          totalCouponBenefit.gt(0) &&
          selected.type !== "COUPON",
        couponShippingActive: selected.type === "COUPON" && selected.shippingActive,
      }
    : {
        type: "NONE",
        label: null,
        discount: "0.00",
        couponSuperseded: false,
        couponShippingActive: false,
      };

  const items = candidates.map((item) => {
    const parentBaseQuantity = baseQuantityByProduct.get(item.productId) ?? 0;
    const wholesaleDifference =
      parentBaseQuantity >= STOREFRONT_WHOLESALE_MINIMUM_BASE_QUANTITY &&
      item.wholesaleUnitPrice
        ? money(item.baseRetailUnitPrice).minus(item.wholesaleUnitPrice)
        : money(0);
    const wholesalePerUnit = wholesaleDifference.gt(0)
      ? wholesaleDifference
      : money(0);
    const selectedDiscount =
      benefit.type === "WHOLESALE"
        ? wholesalePerUnit
        : benefit.type === "OFFER"
          ? money(item.automaticDiscountPerUnit)
          : benefit.type === "COUPON" && minSpendSatisfied
            ? money(item.couponDiscountCandidatePerUnit)
            : money(0);
    const priceAfterBenefit = money(item.retailUnitPrice).minus(selectedDiscount);
    const unitPrice = round2(
      priceAfterBenefit.lt(0) ? money(0) : priceAfterBenefit,
    );
    const lineTotal = round2(unitPrice.times(item.quantity));
    if (!lineTotal.isFinite() || lineTotal.gt(MAX_ONLINE_ORDER_MONEY)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تسعير «${item.productName}»`,
          why: "إجمالي هذا السطر تجاوز السعة المالية المسموحة للطلب",
          doThis: "خفّض الكمية أو قسّمها على طلبين ثم أعد المحاولة",
        }),
      });
    }
    return {
      productId: item.productId,
      categoryId: item.categoryId,
      variantId: item.variantId,
      productName: item.productName,
      isBundle: item.isBundle,
      productUnitId: item.productUnitId,
      quantity: item.quantity,
      baseQuantity: item.baseQuantity,
      retailUnitPrice: item.retailUnitPrice,
      customizationPriceDelta: item.customizationPriceDelta,
      customizationSnapshot: item.customizationSnapshot,
      discountPerUnit: round2(selectedDiscount).toFixed(2),
      couponDiscountPerUnit:
        benefit.type === "COUPON" && minSpendSatisfied
          ? round2(selectedDiscount).toFixed(2)
          : "0.00",
      unitPrice: unitPrice.toFixed(2),
      lineTotal: lineTotal.toFixed(2),
    } satisfies PricedOnlineOrderLine;
  });
  return {
    items,
    benefit,
    wholesaleProgress,
    couponCandidateDiscount: round2(couponMerchandiseDiscount).toFixed(2),
  };
}

/**
 * H3 (٢٩/٨/٢٦): مصدرُ الأجرة يتبع الأولويّة التالية:
 *   ① جدول `deliveryPricingRules` عبر `deliveryZones.code = governorate` (المدير عدّل الأجرة)
 *   ② الافتراض الثابت من `governorates.ts` (السلوك السابق — يبقى للتوافق ولمناطق بلا زون)
 * البذرة (H4، هجرة 0290) تنقل كلّ المحافظات الثمانية عشرة إلى المسار ①.
 */
export async function resolveDeliveryFee(
  tx: Tx,
  governorate: string,
): Promise<import("decimal.js").default> {
  const zone = (
    await tx
      .select({ id: deliveryZones.id, isActive: deliveryZones.isActive })
      .from(deliveryZones)
      .where(eq(deliveryZones.code, governorate))
      .limit(1)
  )[0];
  if (zone && zone.isActive) {
    const quote = await previewDeliveryQuote(tx, Number(zone.id), null, null);
    if (quote) return round2(money(quote.fee));
  }
  return round2(deliveryFeeFor(governorate));
}

export async function totalOnlineOrderQuote(
  tx: Tx,
  items: Array<{ lineTotal: string }>,
  governorate: string,
  freeShippingThreshold: string | null | undefined,
  deliveryEligibilitySubtotal?: string,
  freeShippingThresholdGovernorates?: string | null | undefined,
  couponShipping?: {
    freeShipping?: boolean;
    shippingDiscountAmount?: string | null;
  } | null,
): Promise<
  Pick<
    OnlineOrderQuoteResult,
    | "subtotal"
    | "deliveryFee"
    | "deliveryFree"
    | "deliveryWaivedAmount"
    | "freeShippingThreshold"
    | "freeShippingRemaining"
    | "total"
  > & {
    couponDeliveryWaivedAmount: string;
    couponShippingApplied: boolean;
  }
> {
  const subtotal = round2(sumMoney(items.map((item) => item.lineTotal)));
  if (!subtotal.isFinite() || subtotal.gt(MAX_ONLINE_ORDER_MONEY)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسعير الطلب",
        why: "إجمالي الأصناف تجاوز السعة المالية المسموحة للطلب الواحد",
        doThis: "قسّم الأصناف على طلبين أو أكثر ثم أعد المحاولة",
      }),
    });
  }
  const eligibilitySubtotal = deliveryEligibilitySubtotal == null
    ? subtotal
    : round2(money(deliveryEligibilitySubtotal));
  const actualDeliveryFee = await resolveDeliveryFee(tx, governorate);
  let customerDeliveryFee = actualDeliveryFee;

  const isBaghdad = isBaghdadGovernorate(governorate);
  const applicableThresholdStr = isBaghdad
    ? freeShippingThreshold
    : (freeShippingThresholdGovernorates ?? freeShippingThreshold);
  const configuredThreshold = applicableThresholdStr
    ? money(applicableThresholdStr)
    : null;
  const freeThreshold = configuredThreshold?.gt(0) ? configuredThreshold : null;
  if (couponShipping && money(couponShipping.shippingDiscountAmount).gt(0) && !couponShipping.freeShipping) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تطبيق خصم الشحن",
        why: "الخصم الجزئي على أجور الشحن غير مدعوم في متجر التوصيل، الدعم مخصص للشحن المجاني الكامل",
        doThis: "استخدم كوبون شحن مجاني كامل أو كوبون خصم على الأصناف",
      }),
    });
  }

  const thresholdFree = Boolean(freeThreshold && eligibilitySubtotal.gte(freeThreshold));
  const couponFree = Boolean(
    couponShipping?.freeShipping && !thresholdFree && actualDeliveryFee.gt(0),
  );

  const deliveryFree = thresholdFree || couponFree;
  if (deliveryFree) {
    customerDeliveryFee = round2(money(0));
  }

  const deliveryWaivedAmount = deliveryFree ? actualDeliveryFee : round2(money(0));
  const couponDeliveryWaivedAmount = couponFree ? actualDeliveryFee : round2(money(0));
  const total = round2(subtotal.plus(customerDeliveryFee));
  if (!total.isFinite() || total.gt(MAX_ONLINE_ORDER_MONEY)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسعير الطلب",
        why: "الإجمالي مع أجرة التوصيل تجاوز السعة المالية المسموحة للطلب الواحد",
        doThis: "قسّم الأصناف على طلبين أو أكثر ثم أعد المحاولة",
      }),
    });
  }
  return {
    subtotal: subtotal.toFixed(2),
    deliveryFee: customerDeliveryFee.toFixed(2),
    deliveryFree,
    deliveryWaivedAmount: deliveryWaivedAmount.toFixed(2),
    couponDeliveryWaivedAmount: couponDeliveryWaivedAmount.toFixed(2),
    couponShippingApplied: couponFree,
    freeShippingThreshold: freeThreshold?.toFixed(2) ?? null,
    freeShippingRemaining: freeThreshold
      ? (eligibilitySubtotal.gte(freeThreshold) ? money(0) : freeThreshold.minus(eligibilitySubtotal)).toFixed(2)
      : null,
    total: total.toFixed(2),
  };
}

export async function quoteOnlineOrder(
  input: OnlineOrderQuoteInput,
): Promise<OnlineOrderQuoteResult> {
  const normalizedLines = normalizeOnlineOrderLines(input.lines);
  if (!governorateById(input.governorate))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر حساب أجرة التوصيل",
        why: "المحافظة المختارة ليست من محافظات التوصيل المعروفة لدينا",
        doThis: "اختر محافظتك من القائمة المنسدلة ثمّ أعد المحاولة",
      }),
    });
  // تسعيرةٌ قارئةٌ محضة: **بلا بوّابة الكتابة الماليّة** (فحص الحمل ٣١/٨/٢٦). كانت تأخذ
  // `FINANCIAL_WRITER` (قفلٌ مشترك على صفّ بوّابة الإقفال العالميّ) في كل نداءٍ مجهول من كلّ
  // زائر، وهي لا تكتب شيئاً إطلاقاً — والمعاملة تبقى قائمةً لضمان لقطةٍ متّسقة للأسعار
  // والتوفّر عبر الاستعلامات المتعدّدة، لا للذرّية.
  return withTx(
    async (tx) => {
      const context = await requireStorefrontContext(tx, { requireOpen: true });
      const settings = (
        await tx
          .select({
            freeShippingThreshold: storeSettingsTable.freeShippingThreshold,
            freeShippingThresholdGovernorates: storeSettingsTable.freeShippingThresholdGovernorates,
          })
          .from(storeSettingsTable)
          .where(eq(storeSettingsTable.id, 1))
          .limit(1)
      )[0];
      // بلا `FOR UPDATE` على الكوبون: التسعيرة لا تستهلك استخداماً، والقفل الحصريّ كان يُسلسل
      // كلّ زائرٍ يجرّب الرمز نفسه. حماية الاستهلاك المزدوج تبقى في مسار الإنشاء (lock افتراضيّ).
      const lockedCoupon = input.couponCode
        ? await lockCouponForSale(
            tx,
            {
              code: input.couponCode,
              branchId: context.branchId,
              customerId: input.authenticatedCustomer?.customerId ?? null,
              requireAuthenticatedAssignedCustomer: true,
              authenticatedCustomerId:
                input.authenticatedCustomer?.customerId ?? null,
              todayYmd: todayYmdBaghdad(),
            },
            { lock: false },
          )
        : null;
      const isBaghdad = isBaghdadGovernorate(input.governorate);
      const applicableThresholdStr = isBaghdad
        ? settings?.freeShippingThreshold
        : (settings?.freeShippingThresholdGovernorates ?? settings?.freeShippingThreshold);
      const configuredThreshold = applicableThresholdStr
        ? money(applicableThresholdStr)
        : null;
      const freeThreshold = configuredThreshold?.gt(0) ? configuredThreshold : null;
      const actualDeliveryFee = await resolveDeliveryFee(tx, input.governorate);

      const pricing = await priceOnlineOrderLines(
        tx,
        context.branchId,
        normalizedLines,
        {
          lock: false,
          coupon: lockedCoupon,
          deliveryContext: {
            actualDeliveryFee,
            freeShippingThreshold: freeThreshold,
          },
        },
      );
      const retailSubtotal = round2(
        pricing.items.reduce(
          (sum, item) =>
            sum.plus(money(item.retailUnitPrice).times(item.quantity)),
          money(0),
        ),
      );
      if (
        lockedCoupon &&
        money(lockedCoupon.minOrderSpend).gt(0) &&
        retailSubtotal.lt(money(lockedCoupon.minOrderSpend))
      ) {
        const minSpend = money(lockedCoupon.minOrderSpend);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "لم يبلغ إجمالي الطلب الحد الأدنى لتفعيل الكوبون",
            why: `الحد الأدنى المطلوب لتفعيل هذا الكوبون هو ${minSpend.toFixed(2)} د.ع بينما إجمالي طلبك الحالي ${retailSubtotal.toFixed(2)} د.ع`,
            doThis: "أضف المزيد من المنتجات إلى سلة الشراء لتفعيل الكوبون",
          }),
        });
      }
      const couponShipping =
        pricing.benefit.type === "COUPON" &&
        pricing.benefit.couponShippingActive &&
        lockedCoupon?.freeShipping
          ? {
              freeShipping: true,
              shippingDiscountAmount: lockedCoupon.shippingDiscountAmount,
            }
          : null;
      const totals = await totalOnlineOrderQuote(
        tx,
        pricing.items,
        input.governorate,
        settings?.freeShippingThreshold,
        retailSubtotal.toFixed(2),
        settings?.freeShippingThresholdGovernorates,
        couponShipping,
      );
      const hasMerchandiseDiscount =
        pricing.benefit.type === "COUPON" && money(pricing.benefit.discount).gt(0);
      const hasShippingWaiver =
        totals.couponShippingApplied &&
        money(totals.couponDeliveryWaivedAmount).gt(0);
      const couponBenefitActive =
        pricing.benefit.type === "COUPON" &&
        (hasMerchandiseDiscount || hasShippingWaiver);

      if (lockedCoupon && !pricing.benefit.couponSuperseded && !couponBenefitActive) {
        const isThresholdFree =
          totals.deliveryFree && !totals.couponShippingApplied;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `تعذّر تطبيق الكوبون «${lockedCoupon.code}»`,
            why: isThresholdFree
              ? "سلّتك مؤهّلة بالفعل للتوصيل المجاني التلقائي، فلا يقدّم هذا الكوبون توفيراً إضافياً"
              : "لا صنف في سلّتك يشمله هذا الكوبون ولا يقدّم توفيراً على أجور التوصيل",
            doThis:
              "أزِل الكوبون لإتمام الطلب بالسعر المعروض، أو أضِف أصنافاً أخرى للسلّة",
          }),
        });
      }
      return {
        couponCode: couponBenefitActive ? lockedCoupon?.code ?? null : null,
        couponProgramName: couponBenefitActive
          ? lockedCoupon?.programName ?? null
          : null,
        couponDiscount:
          pricing.benefit.type === "COUPON"
            ? pricing.benefit.discount
            : "0.00",
        pricingBenefitType: pricing.benefit.type,
        pricingBenefitLabel: pricing.benefit.label,
        pricingBenefitDiscount: pricing.benefit.discount,
        couponSuperseded: pricing.benefit.couponSuperseded,
        wholesaleProgress: pricing.wholesaleProgress,
        retailSubtotal: retailSubtotal.toFixed(2),
        lines: pricing.items.map((item) => ({
          productUnitId: item.productUnitId,
          quantity: item.quantity,
          customization: item.customizationSnapshot,
          retailUnitPrice: item.retailUnitPrice,
          discountPerUnit: item.discountPerUnit,
          couponDiscountPerUnit: item.couponDiscountPerUnit ?? "0.00",
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
        })),
        ...totals,
      };
    },
    { gate: "NONE" },
  );
}

/** طلب متجر جديد — server-priced، مُتحقَّق، idempotent، ذرّي. لا أثر مالي (PENDING فقط). */
export async function createOnlineOrder(
  input: CreateOnlineOrderInput,
): Promise<CreateOnlineOrderResult> {
  const result = await retryOnDup(() => createOnlineOrderAttempt(input));
  publishRealtimeEvent(
    REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED,
    {
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      branchId: result.branchId,
      totalAmount: result.total,
      customerName: input.customerName,
      itemsCount: result.itemCount,
    },
    { branchId: result.branchId },
  );
  return result;
}

function normalizeOwnedReplayIdentity(input: CreateOnlineOrderInput) {
  const normalizedLines = normalizeOnlineOrderLines(input.lines);
  const gov = governorateById(input.governorate);
  if (!gov)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إتمام الطلب",
        why: "المحافظة المُرسَلة ليست من محافظات التوصيل المعروفة لدينا، فلا نستطيع حساب الأجرة ولا إسناد المندوب",
        doThis: "اختر محافظتك من القائمة المنسدلة ثمّ أعد تأكيد الطلب",
      }),
    });
  const name = input.customerName.trim();
  const phone = normalizeStorePhone(input.customerPhone);
  if (!name)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إتمام الطلب",
        why: "حقل الاسم فارغ، والمندوب يحتاج اسماً يسأل عنه عند التسليم",
        doThis: "اكتب اسمك في حقل «الاسم» ثمّ أعد تأكيد الطلب",
      }),
    });
  if (!phone)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إتمام الطلب",
        why: "حقل رقم الهاتف فارغ، وهو الوسيلة الوحيدة لتأكيد الطلب معك ولتواصل المندوب",
        doThis: "اكتب رقم هاتفك بصيغة 07XXXXXXXXX ثمّ أعد تأكيد الطلب",
      }),
    });
  if (input.authenticatedCustomer != null) {
    const sessionPhone = normalizeStorePhone(input.authenticatedCustomer.phone);
    if (
      !Number.isInteger(input.authenticatedCustomer.customerId) ||
      input.authenticatedCustomer.customerId <= 0 ||
      sessionPhone !== phone
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر إتمام الطلب",
          why: "رقم الهاتف المكتوب في الطلب لا يطابق رقم الحساب الذي سجّلتَ الدخول به",
          doThis:
            "اكتب رقم حسابك في حقل الهاتف، أو سجّل الخروج وأكمِل الطلب كضيف بالرقم الذي تريده",
        }),
      });
    }
  }
  const address = input.addressText.trim();
  if (!address)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إتمام الطلب",
        why: "حقل العنوان فارغ، ولا يستطيع المندوب الوصول إليك بلا عنوان",
        doThis:
          "اكتب المنطقة وأقرب نقطةٍ دالّة في حقل «العنوان» ثمّ أعد تأكيد الطلب",
      }),
    });
  const requestedLineQuantities = new Map<string, number>();
  for (const line of normalizedLines) {
    requestedLineQuantities.set(onlineOrderLineIdentity(line), line.quantity);
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
  return withTx((tx) =>
    loadOwnedReplay(
      tx,
      input,
      identity.phone,
      identity.requestedShippingAddress,
      identity.requestedLineQuantities,
    ),
  );
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
    const storeSettings = (
      await tx
        .select({
          freeShippingThreshold: storeSettingsTable.freeShippingThreshold,
          freeShippingThresholdGovernorates: storeSettingsTable.freeShippingThresholdGovernorates,
        })
        .from(storeSettingsTable)
        .where(eq(storeSettingsTable.id, 1))
        .limit(1)
    )[0];

    // أول قفل أعمال مشترك: العميل. منه نشتق customerId الحقيقي قبل فحص القسيمة، فلا تبقى
    // القسيمة الشخصية/حد العميل معلّقين على customerId=null. الجلسة الموثقة يجب أن تطابق الصف.
    const customerId = await lockOrCreateOnlineCustomer(
      tx,
      phone,
      name,
      input.authenticatedCustomer,
    );
    const lockedCoupon = input.couponCode
      ? await lockCouponForSale(tx, {
          code: input.couponCode,
          branchId,
          customerId,
          requireAuthenticatedAssignedCustomer: true,
          authenticatedCustomerId:
            input.authenticatedCustomer?.customerId ?? null,
          todayYmd: todayYmdBaghdad(),
        })
      : null;

    const isBaghdad = isBaghdadGovernorate(input.governorate);
    const applicableThresholdStr = isBaghdad
      ? storeSettings?.freeShippingThreshold
      : (storeSettings?.freeShippingThresholdGovernorates ?? storeSettings?.freeShippingThreshold);
    const configuredThreshold = applicableThresholdStr
      ? money(applicableThresholdStr)
      : null;
    const freeThreshold = configuredThreshold?.gt(0) ? configuredThreshold : null;
    const actualDeliveryFee = await resolveDeliveryFee(tx, input.governorate);
    const deliveryContext = {
      actualDeliveryFee,
      freeShippingThreshold: freeThreshold,
    };

    // ② لقطة تسعير أولية لبناء متطلبات الأقفال. التثبيت المالي الوحيد أدناه يعيد
    // تشغيل المحرك نفسه بقراءة current مقفلة بعد قفل الوحدات.
    const initialPricing = await priceOnlineOrderLines(tx, branchId, normalizedLines, {
      lock: false,
      coupon: lockedCoupon,
      deliveryContext,
    });
    const items = initialPricing.items;
    const requestedBaseByVariant = new Map<number, number>();

    // ترتيب الأقفال العالمي: customer → productUnit → variant/branchStock → order/items.
    // نقفل معنى الكمية قبل الوصفة وATP؛ تعديل العامل المتزامن إمّا يسبقنا فنرفض
    // لقطة السلة القديمة، أو ينتظرنا ثم يرى الطلب النشط ويرفض التعديل.
    const unitIds = Array.from(
      new Set(items.map((item) => item.productUnitId)),
    ).sort((a, b) => a - b);
    const currentUnits = await lockProductUnitsForOnlineAllocation(tx, unitIds);
    const currentFactorByUnit = new Map(
      currentUnits.map((unit) => [unit.id, unit.conversionFactor]),
    );
    const currentPricing = await priceOnlineOrderLines(
      tx,
      branchId,
      normalizedLines,
      { lock: true, coupon: lockedCoupon, deliveryContext },
    );
    const currentItems = currentPricing.items;
    requestedBaseByVariant.clear();
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const current = currentItems[index];
      const factor = current
        ? currentFactorByUnit.get(current.productUnitId)
        : undefined;
      if (
        !current ||
        current.productUnitId !== item.productUnitId ||
        factor == null ||
        !money(item.quantity).times(factor).eq(item.baseQuantity)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إتمام الطلب",
            why: "تغيّر أحد أصناف سلّتك في أثناء تأكيد الطلب فلم يعد متاحاً بالشكل الذي عُرض لك (تبدّلت عبوته أو أُوقف عرضه)",
            doThis:
              "حدّث الصفحة لترى السلّة بأصنافها وأسعارها الحالية، ثمّ أعد تأكيد الطلب",
          }),
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
      const requestedBase =
        (requestedBaseByVariant.get(current.variantId) ?? 0) +
        current.baseQuantity;
      requestedBaseByVariant.set(current.variantId, requestedBase);
    }
    for (let index = 0; index < items.length; index++) {
      const expected = normalizedLines[index]?.expectedUnitPrice;
      if (expected != null && !round2(expected).eq(items[index].unitPrice)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تغيّر سعر أحد الأصناف قبل تأكيد الطلب",
            why: `السعر المعروض في سلّتك ${expected} د.ع والسعر الحالي ${items[index].unitPrice} د.ع، ولا نُتمّ طلباً بسعرٍ لم تره`,
            doThis:
              "حدّث الصفحة لترى السعر الجديد، ثمّ اضغط «تأكيد الطلب» للموافقة عليه",
          }),
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
          message: appErrorMessage({
            what: `تعذّر طلب «${item.productName}»`,
            why: "محتويات هذا العرض غير مكتملة عندنا الآن، فلا نستطيع تجهيزه كما هو معروض",
            doThis:
              "احذفه من السلّة وأكمِل بقيّة الطلب، أو تواصل معنا لنُخبرك متى يجهز",
          }),
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
    const retailSubtotal = round2(items.reduce(
      (sum, item) => sum.plus(money(item.retailUnitPrice).times(item.quantity)),
      money(0),
    ));
    if (
      lockedCoupon &&
      money(lockedCoupon.minOrderSpend).gt(0) &&
      retailSubtotal.lt(money(lockedCoupon.minOrderSpend))
    ) {
      const minSpend = money(lockedCoupon.minOrderSpend);
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لم يبلغ إجمالي الطلب الحد الأدنى لتفعيل الكوبون",
          why: `الحد الأدنى المطلوب لتفعيل هذا الكوبون هو ${minSpend.toFixed(2)} د.ع بينما إجمالي طلبك الحالي ${retailSubtotal.toFixed(2)} د.ع`,
          doThis: "أضف المزيد من المنتجات إلى سلة الشراء لتفعيل الكوبون",
        }),
      });
    }
    const couponShipping =
      currentPricing.benefit.type === "COUPON" &&
      currentPricing.benefit.couponShippingActive &&
      lockedCoupon?.freeShipping
        ? {
            freeShipping: true,
            shippingDiscountAmount: lockedCoupon.shippingDiscountAmount,
          }
        : null;
    const quoteTotals = await totalOnlineOrderQuote(
      tx,
      items,
      input.governorate,
      storeSettings?.freeShippingThreshold,
      retailSubtotal.toFixed(2),
      storeSettings?.freeShippingThresholdGovernorates,
      couponShipping,
    );
    const hasMerchandiseDiscount =
      currentPricing.benefit.type === "COUPON" && money(currentPricing.benefit.discount).gt(0);
    const hasShippingWaiver =
      quoteTotals.couponShippingApplied &&
      money(quoteTotals.couponDeliveryWaivedAmount).gt(0);
    const couponBenefitActive =
      currentPricing.benefit.type === "COUPON" && (hasMerchandiseDiscount || hasShippingWaiver);

    if (lockedCoupon && !currentPricing.benefit.couponSuperseded && !couponBenefitActive) {
      const isThresholdFree =
        quoteTotals.deliveryFree && !quoteTotals.couponShippingApplied;
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تطبيق الكوبون «${lockedCoupon.code}»`,
          why: isThresholdFree
            ? "سلّتك مؤهّلة بالفعل للتوصيل المجاني التلقائي، فلا يقدّم هذا الكوبون توفيراً إضافياً"
            : "لا صنف في سلّتك يشمله هذا الكوبون ولا يقدّم توفيراً على أجور التوصيل",
          doThis:
            "أزِل الكوبون لإتمام الطلب بالسعر المعروض، أو أضِف أصنافاً أخرى للسلّة",
        }),
      });
    }
    const subtotal = money(quoteTotals.subtotal);
    const deliveryFee = money(quoteTotals.deliveryFee);
    const total = money(quoteTotals.total);
    if (
      input.expectedGrandTotal != null &&
      !round2(input.expectedGrandTotal).eq(total)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تغيّر إجمالي الطلب قبل تأكيده",
          why: `الإجمالي الذي وافقتَ عليه ${String(input.expectedGrandTotal)} د.ع والإجمالي الحالي ${quoteTotals.total} د.ع بعد احتساب الأصناف وأجرة التوصيل`,
          doThis:
            "راجِع الإجمالي الجديد في السلّة، ثمّ اضغط «تأكيد الطلب» للموافقة عليه",
        }),
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
      // ⚠️ **ثلاثةُ أسبابٍ لا سببٌ واحد** — والشرطُ والترتيب والرمز كما كانت حرفياً، فُصلت
      // الفروع للرسالة وحدها. أوّلُ صياغةٍ بالعقد جزمت بسببٍ واحد («الحجوزات تشغل المتوفّر»)
      // فصار **كذباً محضاً** في فرعَي «الصنف غير معروض» و«صنفٌ مركّب»، و«أنقص الكمية» طريقاً
      // مسدوداً فيهما: تخفيضُ الكمية لا يُصلح صنفاً ليس في خريطة التوفّر أصلاً.
      // ⇒ **`why` سببٌ لا تخمين** (عقد `shared/errors.ts`)، والزبونُ يقرأ هذه الرسائل لا الموظّف.
      if (!available) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إتمام الطلب",
            why: "أحد أصناف سلّتك لم يعد معروضاً للبيع",
            doThis:
              "احذف الصنف من السلّة وأعد المحاولة، أو تواصل معنا لنوفّره لك",
          }),
        });
      }
      if (available.isBundle) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إتمام الطلب",
            why: "أحد أصناف سلّتك عرضٌ مركّب لا يُتاح طلبه من المتجر",
            doThis:
              "احذف الصنف من السلّة وأعد المحاولة، وتواصل معنا لطلبه مباشرةً",
          }),
        });
      }
      if (requiredBase > available.availableBase) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إتمام الطلب",
            why: // ⚠️ **عبارتان متعاقَدٌ عليهما في هذه الرسالة الواحدة، لا واحدة**:
            // «الحجوزات النشطة» يطابقها اختبارُ ATP بعد الحجوزات، و«الطلبات النشطة»
            // يطابقها اختبارُ البكج (`bundle-blocks-component`) — كلاهما في
            // `onlineOrderAvailability.test.ts`. أوّلُ صياغةٍ حفظت الأولى وأسقطت الثانية،
            // فمرّت الأنواعُ والحرّاسُ خضراءَ وسقطت الحزمةُ على CI وحدها.
            // ⇒ أيّ إعادة صياغةٍ هنا تُبقي **العبارتين حرفياً**.
            "الكمية المطلوبة من أحد أصناف سلّتك أكثر من المتوفّر الآن بعد احتساب الحجوزات النشطة والطلبات النشطة لزبائن آخرين",
            doThis:
              "أنقص الكمية أو احذف الصنف ثمّ أعد المحاولة، أو تواصل معنا لنحجزه لك حين يصل",
          }),
        });
      }
    }

    const selectedCoupon = couponBenefitActive ? lockedCoupon : null;
    // خصم البضائع المباشر فقط يدخل في couponDiscount لمنع ازدواجية الخصم مع إعفاء التوصيل في الفواتير والتقارير
    const merchandiseCouponDiscount = hasMerchandiseDiscount
      ? money(currentPricing.benefit.discount)
      : money(0);
    const couponReservationAmount = hasMerchandiseDiscount
      ? merchandiseCouponDiscount
      : money(quoteTotals.couponDeliveryWaivedAmount);

    // ④ إنشاء الطلب (PENDING) — رقمٌ مؤقّت فريد ثم ORD-{id} (بلا سباق ترقيم).
    const guestTrackingPublicId = randomBytes(16).toString("hex");
    const guestTrackingExpiresAt = new Date(
      Date.now() + GUEST_TRACKING_TTL_SECONDS * 1000,
    );
    const guestTrackingToken = buildGuestTrackingToken(
      guestTrackingPublicId,
      guestTrackingExpiresAt,
    );
    const baseTracking = await nextTransactionTrackingNumber(tx);
    const orderNumber = `ORD-${baseTracking}`;
    const insOrder = await tx.insert(onlineOrders).values({
      orderNumber,
      customerId,
      branchId,
      subtotal: toDbMoney(subtotal),
      shippingCost: toDbMoney(deliveryFee),
      deliveryFree: quoteTotals.deliveryFree,
      deliveryWaivedAmount: toDbMoney(quoteTotals.deliveryWaivedAmount),
      taxAmount: "0",
      total: toDbMoney(total),
      status: "PENDING",
      shippingAddress: requestedShippingAddress,
      customerNotes: input.notes?.trim() ? input.notes.trim() : null,
      governorate: input.governorate,
      latitude: input.latitude != null ? String(input.latitude) : null,
      longitude: input.longitude != null ? String(input.longitude) : null,
      clientRequestId: input.clientRequestId ?? null,
      guestTrackingPublicId,
      guestTrackingTokenHash: hashGuestTrackingToken(guestTrackingToken),
      guestTrackingExpiresAt,
      couponCode: selectedCoupon?.code ?? null,
      couponDiscount: toDbMoney(merchandiseCouponDiscount),
      pricingBenefitType: currentPricing.benefit.type,
      pricingBenefitLabel: currentPricing.benefit.label,
      pricingBenefitDiscount: toDbMoney(currentPricing.benefit.discount),
    });
    const orderId = extractInsertId(insOrder);
    // تُثبَّت داخل معاملة الإنشاء بساعة MySQL؛ لا يظهر طلب جديد بلا مهلة.
    await tx.execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 24 HOUR)
      WHERE id = ${orderId}
    `);
    const persistedExpiry = (
      await tx
        .select({
          reservationExpiryMs: sql<
            number | null
          >`ROUND(UNIX_TIMESTAMP(\`onlineOrders\`.\`reservationExpiresAt\`) * 1000)`,
        })
        .from(onlineOrders)
        .where(eq(onlineOrders.id, orderId))
        .limit(1)
    )[0]?.reservationExpiryMs;
    if (persistedExpiry == null) {
      throw new Error(
        "Online order reservation expiry snapshot was not persisted",
      );
    }
    const reservationExpiresAt = new Date(Number(persistedExpiry));

    // ⑤ بنود الطلب (لقطة السعر الخادمي).
    if (items.length > 0) {
      await tx.insert(onlineOrderItems).values(
        items.map((it) => ({
          onlineOrderId: orderId,
          variantId: it.variantId,
          productUnitId: it.productUnitId,
          quantity: toDbQty(it.quantity),
          baseQuantity: it.baseQuantity,
          unitPrice: it.unitPrice,
          total: it.lineTotal,
          customizationSnapshot: it.customizationSnapshot,
        })),
      );
      const attachedAssetKeys = Array.from(
        new Set(
          items.flatMap((it) => {
            const snap = it.customizationSnapshot;
            if (!snap) return [];
            return [snap.logoAssetKey, snap.previewAssetKey].filter(
              (k): k is string => typeof k === "string" && k.length > 0,
            );
          }),
        ),
      );
      if (attachedAssetKeys.length > 0) {
        await tx
          .update(storefrontCustomizationAssets)
          .set({ expiresAt: null })
          .where(inArray(storefrontCustomizationAssets.assetKey, attachedAssetKeys));
      }
    }
    if (selectedCoupon && couponReservationAmount.gt(0)) {
      await reserveCouponForOnlineOrder(tx, selectedCoupon, {
        onlineOrderId: orderId,
        customerId,
        branchId,
        discountAmount: couponReservationAmount.toFixed(2),
        expiresAt: reservationExpiresAt,
      });
    }

    return {
      orderId,
      orderNumber,
      reservationExpiresAt,
      branchId,
      subtotal: toDbMoney(subtotal),
      deliveryFee: toDbMoney(deliveryFee),
      deliveryFree: quoteTotals.deliveryFree,
      deliveryWaivedAmount: toDbMoney(quoteTotals.deliveryWaivedAmount),
      total: toDbMoney(total),
      itemCount: items.length,
      guestTrackingToken,
      guestTrackingExpiresAt,
    };
  });
}

export interface OnlineOrderTracking {
  orderNumber: string;
  status: string;
  deliveryProgress?: { label: string; updatedAt: Date | string | null; complete?: boolean; phase?: "RETURNED" | "AWAITING_REASSIGNMENT" | "RETURN_REQUESTED" };
  subtotal: string;
  pricingBenefitType: StorefrontPricingBenefitType;
  pricingBenefitLabel: string | null;
  pricingBenefitDiscount: string;
  deliveryFee: string;
  deliveryFree: boolean;
  deliveryWaivedAmount: string;
  total: string;
  governorate: string | null;
  createdAt: Date;
  deliveryHandshakeOtp?: string | null;
  items: {
    productId?: number | null;
    productName: string;
    unitName: string;
    quantity: string;
    unitPrice: string;
    total: string;
  }[];
}

/**
 * توليد رمز التسليم السري للعميل (Delivery Handshake OTP):
 * رمز رقمي مشفر من 4 أرقام مشتق حتمياً من رقم الطلب وتاريخ إنشائه مع سر النظام.
 * يزود به الزبون يداً بيد للمندوب لإثبات التسليم الفعلي وتحصين أموال COD ضد الاحتيال.
 */
export function computeOrderDeliveryOtp(orderNumber: string, createdAt: Date | string | number): string {
  const baseSecret = process.env.DELIVERY_OTP_SECRET || process.env.JWT_SECRET;
  if (!baseSecret && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET or DELIVERY_OTP_SECRET is required to generate delivery handshake OTP");
  }
  const secretKey = (baseSecret || "alroya_delivery_secret_dev") + ":delivery_handshake_otp_domain_v1";
  const ts = new Date(createdAt).getTime();
  const hmac = createHmac("sha256", secretKey).update(`${orderNumber}:${ts}`).digest("hex");
  const num = (parseInt(hmac.slice(0, 8), 16) % 9000) + 1000;
  return num.toString();
}

/**
 * المسار الإرثي مغلق عمداً: رقم الطلب متسلسل والهاتف ليس عامل مصادقة. لا يقرأ DB إطلاقاً كي
 * لا يبقى أيّ oracle يميّز «طلب موجود/هاتف صحيح» في endpoint العام القديم.
 */
export async function trackOnlineOrder(
  _orderNumber: string,
  _phone: string,
): Promise<never> {
  throw new TRPCError({
    code: "NOT_FOUND",
    message: appErrorMessage({
      what: "تعذّر تتبّع الطلب بهذه الطريقة",
      why: "التتبّع برقم الطلب والهاتف أُغلق حمايةً لطلبات الزبائن من التخمين",
      doThis:
        "افتح رابط التتبّع الذي وصلك مع تأكيد الطلب، أو سجّل الدخول بحسابك لترى طلباتك",
    }),
  });
}

type TrackingHeader = {
  id: number;
  orderNumber: string;
  status: string;
  subtotal: string;
  pricingBenefitType: StorefrontPricingBenefitType;
  pricingBenefitLabel: string | null;
  pricingBenefitDiscount: string;
  shippingCost: string;
  deliveryFree: boolean;
  deliveryWaivedAmount: string;
  total: string;
  governorate: string | null;
  createdAt: Date;
};

async function buildOnlineOrderTracking(
  db: NonNullable<ReturnType<typeof getDb>>,
  order: TrackingHeader,
): Promise<OnlineOrderTracking> {
  const rows = await db
    .select({
      productId: products.id,
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

  const lifecycle = (await loadOnlineOrderLifecycles(db, [Number(order.id)])).get(Number(order.id));
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    deliveryProgress: lifecycle ? { label: lifecycle.label, updatedAt: lifecycle.latestEvent?.occurredAt ?? null, complete: lifecycle.trackingComplete === true, phase: lifecycle.customerPhase } : undefined,
    subtotal: String(order.subtotal),
    pricingBenefitType: order.pricingBenefitType,
    pricingBenefitLabel: order.pricingBenefitLabel ?? null,
    pricingBenefitDiscount: String(order.pricingBenefitDiscount ?? "0"),
    deliveryFee: String(order.shippingCost),
    deliveryFree: order.deliveryFree === true,
    deliveryWaivedAmount: String(order.deliveryWaivedAmount ?? "0"),
    total: String(order.total),
    governorate: order.governorate ?? null,
    createdAt: order.createdAt,
    deliveryHandshakeOtp: computeOrderDeliveryOtp(order.orderNumber, order.createdAt),
    items: rows.map((r) => ({
      productId: Number(r.productId),
      productName: r.productName,
      unitName: r.unitName ?? "",
      quantity: String(r.quantity),
      unitPrice: String(r.unitPrice),
      total: String(r.total),
    })),
  };
}

function trackingHeaderSelection() {
  return {
    id: onlineOrders.id,
    orderNumber: onlineOrders.orderNumber,
    status: currentOnlineOrderStatus,
    subtotal: onlineOrders.subtotal,
    pricingBenefitType: onlineOrders.pricingBenefitType,
    pricingBenefitLabel: onlineOrders.pricingBenefitLabel,
    pricingBenefitDiscount: onlineOrders.pricingBenefitDiscount,
    shippingCost: onlineOrders.shippingCost,
    deliveryFree: onlineOrders.deliveryFree,
    deliveryWaivedAmount: onlineOrders.deliveryWaivedAmount,
    total: onlineOrders.total,
    governorate: onlineOrders.governorate,
    createdAt: onlineOrders.createdAt,
  };
}

/** تتبّع موثّق: رقم الطلب selector فقط؛ الملكية من customerId الموقّع بعد فحص نشاط العميل وهاتفه. */
export async function trackOnlineOrderForCustomer(
  orderNumber: string,
  customerId: number,
): Promise<OnlineOrderTracking> {
  const db = getDb();
  if (!db)
    // ⭐ الرمزُ `INTERNAL_SERVER_ERROR` لا `NOT_FOUND` — أمسكته مراجعةٌ عدائية (٢/٩/٢٦):
    // `!db` تعطُّلُ خدمةٍ لا مستندٌ مفقود. و[`Storefront.tsx`](../../client/src/pages/Storefront.tsx)
    // **يتفرّع على الرمز ويُلغي نصَّ الرسالة** (`code === "NOT_FOUND" ? "notfound" : "error"`)
    // ⇒ كان الزبون يرى «طلبك غير موجود» أثناء تعطُّل القاعدة: خبرٌ كاذبٌ عن طلبه هو، لا
    // مجرّد تناقضٍ في الصياغة. وإصلاحُ النصّ وحده لا يبلغه أصلاً لأنّ الشاشة تطرحه.
    // ⚠️ ولا يمسّ هذا `NOT_FOUND` **المقصود** على الرمز المزوَّر أو المُدوَّر أو طلبِ زبونٍ آخر
    // (`onlineOrderTrackingSecurity.test.ts`): إخفاءُ الوجود هناك ضابطٌ يمنع الاستكشاف.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر عرض الطلب الآن",
        why: "خدمة الطلبات غير متاحة مؤقّتاً — طلبك لم يُفقد ولم يتغيّر شيء فيه",
        doThis: "أعد المحاولة بعد دقائق، وإن استمرّ الأمر فتواصل معنا",
      }),
    });
  const order = (
    await db
      .select(trackingHeaderSelection())
      .from(onlineOrders)
      .where(
        and(
          eq(onlineOrders.orderNumber, orderNumber.trim()),
          eq(onlineOrders.customerId, customerId),
        ),
      )
      .limit(1)
  )[0];
  if (!order)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر عرض الطلب",
        why: "لا يوجد طلبٌ بهذا الرقم على حسابك، أو أنّ الرقم غير صحيح",
        doThis:
          "افتح «طلباتي» واختر الطلب من القائمة، أو تواصل معنا ومعك رقم الطلب",
      }),
    });
  return buildOnlineOrderTracking(db, order);
}

/** تتبّع ضيف برمز opaque وحده؛ توقيع/انتهاء/تطابق hash تُفحص قبل إعادة أيّ بيانات. */
export async function trackOnlineOrderByGuestToken(
  token: string,
): Promise<OnlineOrderTracking> {
  const verified = parseAndVerifyGuestTrackingToken(token);
  if (!verified)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح صفحة تتبّع الطلب",
        why: "رمز التتبّع غير صالح أو انتهت صلاحيته (الرمز يعمل 30 يوماً من تاريخ الطلب)",
        doThis:
          "افتح الرابط كاملاً كما وصلك مع تأكيد الطلب، أو سجّل الدخول بحسابك لترى طلباتك، أو تواصل معنا",
      }),
    });
  const db = getDb();
  if (!db)
    // ⭐ الرمزُ `INTERNAL_SERVER_ERROR` لا `NOT_FOUND` — أمسكته مراجعةٌ عدائية (٢/٩/٢٦):
    // `!db` تعطُّلُ خدمةٍ لا مستندٌ مفقود. و[`Storefront.tsx`](../../client/src/pages/Storefront.tsx)
    // **يتفرّع على الرمز ويُلغي نصَّ الرسالة** (`code === "NOT_FOUND" ? "notfound" : "error"`)
    // ⇒ كان الزبون يرى «طلبك غير موجود» أثناء تعطُّل القاعدة: خبرٌ كاذبٌ عن طلبه هو، لا
    // مجرّد تناقضٍ في الصياغة. وإصلاحُ النصّ وحده لا يبلغه أصلاً لأنّ الشاشة تطرحه.
    // ⚠️ ولا يمسّ هذا `NOT_FOUND` **المقصود** على الرمز المزوَّر أو المُدوَّر أو طلبِ زبونٍ آخر
    // (`onlineOrderTrackingSecurity.test.ts`): إخفاءُ الوجود هناك ضابطٌ يمنع الاستكشاف.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر عرض الطلب الآن",
        why: "خدمة الطلبات غير متاحة مؤقّتاً — طلبك لم يُفقد ولم يتغيّر شيء فيه",
        doThis: "أعد المحاولة بعد دقائق، وإن استمرّ الأمر فتواصل معنا",
      }),
    });
  const order = (
    await db
      .select({
        ...trackingHeaderSelection(),
        guestTrackingExpiresAt: onlineOrders.guestTrackingExpiresAt,
      })
      .from(onlineOrders)
      .where(
        and(
          eq(onlineOrders.guestTrackingPublicId, verified.publicId),
          eq(onlineOrders.guestTrackingTokenHash, verified.tokenHash),
          sql`${onlineOrders.guestTrackingExpiresAt} > CURRENT_TIMESTAMP(3)`,
        ),
      )
      .limit(1)
  )[0];
  const storedExpirySeconds =
    order?.guestTrackingExpiresAt == null
      ? null
      : Math.floor(order.guestTrackingExpiresAt.getTime() / 1000);
  if (!order || storedExpirySeconds !== verified.expiresAtSeconds) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح صفحة تتبّع الطلب",
        why: "رمز التتبّع غير صالح أو انتهت صلاحيته (الرمز يعمل 30 يوماً من تاريخ الطلب)",
        doThis:
          "افتح الرابط كاملاً كما وصلك مع تأكيد الطلب، أو سجّل الدخول بحسابك لترى طلباتك، أو تواصل معنا",
      }),
    });
  }
  return buildOnlineOrderTracking(db, order);
}

type CancellableOnlineOrder = {
  id: number;
  orderNumber: string;
  status: string;
};

/** العميل لا يغيّر سير التشغيل: الإلغاء الذاتي متاح فقط قبل اعتماد الموظف. */
async function cancelPendingOnlineOrder(
  tx: Tx,
  order: CancellableOnlineOrder | undefined,
): Promise<{ orderNumber: string; status: "CANCELLED" }> {
  if (!order)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح الطلب",
        why: "لا يوجد طلب متاح بهذه الصلاحية",
        doThis: "حدّث قائمة طلباتك أو تواصل معنا ومعك رقم الطلب",
      }),
    });
  if (order.status !== "PENDING")
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "لا يمكن إلغاء الطلب ذاتياً الآن",
        why: "اعتمد موظف المكتبة الطلب أو بدأ تجهيزه، فلا نغيّر حالته تلقائياً حتى لا يتعطل التجهيز أو التوصيل",
        doThis: "أرسل طلب تعديل أو إلغاء إلى فريق المكتبة ليراجعه معك",
      }),
    });
  const cancelReason = "أُلغي من العميل قبل تأكيد المكتبة";
  await tx
    .update(onlineOrders)
    .set({ status: "CANCELLED", cancelReason })
    .where(and(eq(onlineOrders.id, order.id), eq(onlineOrders.status, "PENDING")));
  await releaseCouponReservationForOnlineOrder(tx, order.id, cancelReason);
  return { orderNumber: order.orderNumber, status: "CANCELLED" };
}

/** إلغاء مالك موثّق: رقم الطلب selector فقط وملكية العميل محكومة بخادم الجلسة. */
export async function cancelOnlineOrderForCustomer(
  orderNumber: string,
  customerId: number,
): Promise<{ orderNumber: string; status: "CANCELLED" }> {
  return withTx(async (tx) => {
    const order = (
      await tx
        .select({
          id: onlineOrders.id,
          orderNumber: onlineOrders.orderNumber,
          status: onlineOrders.status,
        })
        .from(onlineOrders)
        .where(
          and(
            eq(onlineOrders.orderNumber, orderNumber.trim()),
            eq(onlineOrders.customerId, customerId),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    return cancelPendingOnlineOrder(
      tx,
      order && {
        id: Number(order.id),
        orderNumber: order.orderNumber,
        status: order.status,
      },
    );
  });
}

/** إلغاء ضيف بالرمز opaque نفسه المخصص للتتبّع؛ لا يقبل رقم طلب قابل للتخمين. */
export async function cancelOnlineOrderByGuestToken(
  token: string,
): Promise<{ orderNumber: string; status: "CANCELLED" }> {
  const verified = parseAndVerifyGuestTrackingToken(token);
  if (!verified)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح الطلب",
        why: "رمز التتبّع غير صالح أو انتهت صلاحيته",
        doThis: "سجّل الدخول بحسابك لرؤية الطلب، أو تواصل معنا ومعك رقم الطلب",
      }),
    });
  return withTx(async (tx) => {
    const order = (
      await tx
        .select({
          id: onlineOrders.id,
          orderNumber: onlineOrders.orderNumber,
          status: onlineOrders.status,
          guestTrackingExpiresAt: onlineOrders.guestTrackingExpiresAt,
        })
        .from(onlineOrders)
        .where(
          and(
            eq(onlineOrders.guestTrackingPublicId, verified.publicId),
            eq(onlineOrders.guestTrackingTokenHash, verified.tokenHash),
            sql`${onlineOrders.guestTrackingExpiresAt} > CURRENT_TIMESTAMP(3)`,
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    const storedExpirySeconds =
      order?.guestTrackingExpiresAt == null
        ? null
        : Math.floor(order.guestTrackingExpiresAt.getTime() / 1000);
    if (!order || storedExpirySeconds !== verified.expiresAtSeconds) {
      return cancelPendingOnlineOrder(tx, undefined);
    }
    return cancelPendingOnlineOrder(tx, {
      id: Number(order.id),
      orderNumber: order.orderNumber,
      status: order.status,
    });
  });
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
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح ملصق الطرد",
        why: "توقيع الملصق لا يطابق رقم الطلب المطبوع عليه، فقد يكون الملصق تالفاً أو المسح ناقصاً",
        doThis:
          "امسح رمز الملصق كاملاً من جديد، وإن تكرّر فاتّصل بالمكتبة لتأكيد الطرد",
      }),
    });
  }
  const db = getDb();
  if (!db)
    // ⭐ الرمزُ `INTERNAL_SERVER_ERROR` لا `NOT_FOUND` — أمسكته مراجعةٌ عدائية (٢/٩/٢٦):
    // `!db` تعطُّلُ خدمةٍ لا مستندٌ مفقود. و[`Storefront.tsx`](../../client/src/pages/Storefront.tsx)
    // **يتفرّع على الرمز ويُلغي نصَّ الرسالة** (`code === "NOT_FOUND" ? "notfound" : "error"`)
    // ⇒ كان الزبون يرى «طلبك غير موجود» أثناء تعطُّل القاعدة: خبرٌ كاذبٌ عن طلبه هو، لا
    // مجرّد تناقضٍ في الصياغة. وإصلاحُ النصّ وحده لا يبلغه أصلاً لأنّ الشاشة تطرحه.
    // ⚠️ ولا يمسّ هذا `NOT_FOUND` **المقصود** على الرمز المزوَّر أو المُدوَّر أو طلبِ زبونٍ آخر
    // (`onlineOrderTrackingSecurity.test.ts`): إخفاءُ الوجود هناك ضابطٌ يمنع الاستكشاف.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر عرض الطلب الآن",
        why: "خدمة الطلبات غير متاحة مؤقّتاً — طلبك لم يُفقد ولم يتغيّر شيء فيه",
        doThis: "أعد المحاولة بعد دقائق، وإن استمرّ الأمر فتواصل معنا",
      }),
    });
  const order = (
    await db
      .select({
        id: onlineOrders.id,
        orderNumber: onlineOrders.orderNumber,
        status: currentOnlineOrderStatus,
        subtotal: onlineOrders.subtotal,
        pricingBenefitType: onlineOrders.pricingBenefitType,
        pricingBenefitLabel: onlineOrders.pricingBenefitLabel,
        pricingBenefitDiscount: onlineOrders.pricingBenefitDiscount,
        shippingCost: onlineOrders.shippingCost,
        deliveryFree: onlineOrders.deliveryFree,
        deliveryWaivedAmount: onlineOrders.deliveryWaivedAmount,
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
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر فتح ملصق الطرد",
        why: "لا يوجد طلبٌ بالرقم المطبوع على الملصق",
        doThis:
          "تأكّد من مسح الملصق الصحيح، واتّصل بالمكتبة لتأكيد رقم الطلب إن بقي الأمر",
      }),
    });
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
    pricingBenefitType: order.pricingBenefitType,
    pricingBenefitLabel: order.pricingBenefitLabel ?? null,
    pricingBenefitDiscount: String(order.pricingBenefitDiscount ?? "0"),
    deliveryFee: String(order.shippingCost),
    deliveryFree: order.deliveryFree === true,
    deliveryWaivedAmount: String(order.deliveryWaivedAmount ?? "0"),
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
