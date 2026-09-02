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
import { appErrorMessage } from "@shared/errors";
import { deliveryFeeFor, governorateById } from "@shared/governorates";
import { previewDeliveryQuote } from "./delivery/pricingRules";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { normalizeIraqPhoneE164 } from "../lib/phone";
import { money, round2, sumMoney, toDbMoney, toDbQty } from "./money";
import { resolvePromotionForLine } from "./salesPromotionService";
import { requireStorefrontContext } from "./storefrontContextService";
import { withTx } from "./tx";
import {
  lockCouponForSale,
  normalizeCouponCode,
  reserveCouponForOnlineOrder,
  type LockedCoupon,
} from "./couponService";
import { resolveCouponPromotionForLine } from "./salesPromotionService";
import { verifyOnlineOrderLabelToken } from "./barcodeService";
import {
  loadVariantAvailability,
  lockProductUnitsForOnlineAllocation,
} from "./catalog/variantAvailability";
import { retryOnDup } from "../lib/retryDup";

const RETAIL = "RETAIL" as const;
const GUEST_TRACKING_TTL_SECONDS = 60 * 60 * 24 * 30;
const GUEST_TRACKING_DOMAIN = "STORE_GUEST_TRACKING_V1";

function guestTrackingSecret(): string {
  const secret = process.env.BARCODE_SECRET;
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
  /** السعر الذي ظهر للزبون عند التأكيد؛ لا يُستعمل للتسعير بل كـoptimistic contract. */
  expectedUnitPrice?: string | null;
}

export const MAX_ONLINE_ORDER_DISTINCT_UNITS = 30;
export const MAX_ONLINE_ORDER_QUANTITY_PER_UNIT = 999;
export const MAX_ONLINE_ORDER_TOTAL_QUANTITY = 10_000;

function normalizeExpectedUnitPrice(
  value: string | null | undefined,
): string | null | undefined {
  if (value == null) return value;
  try {
    if (!/^\d{1,15}(?:\.\d{1,2})?$/.test(value))
      throw new Error("invalid price shape");
    const parsed = money(value);
    if (!parsed.isFinite() || parsed.lt(0) || parsed.decimalPlaces() > 2)
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

/**
 * عقد سلة علني موحّد للـquote والإنشاء: يدمج تكرار productUnitId قبل أي SQL، ويبقي كل لون
 * (وحدة/متغيّر مختلف) سطراً مستقلاً. الحدود تُطبّق بعد الدمج كي لا تتجاوزها دفعات مكررة.
 */
export function normalizeOnlineOrderLines(
  lines: ReadonlyArray<
    Pick<
      OnlineOrderLineInput,
      "productUnitId" | "quantity" | "expectedUnitPrice"
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
  const byUnit = new Map<number, OnlineOrderLineInput>();
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
    const current = byUnit.get(productUnitId);
    if (!current) {
      if (byUnit.size >= MAX_ONLINE_ORDER_DISTINCT_UNITS) {
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
      const added = { productUnitId, quantity, expectedUnitPrice };
      byUnit.set(productUnitId, added);
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
    const mergedQuantity = byUnit.get(productUnitId)!.quantity;
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
async function lockOrCreateOnlineCustomer(
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
  /** يحقنها الراوتر بعد تحقق جلسة Firebase؛ تمكّن القسائم الشخصية وحدّ العميل. */
  authenticatedCustomer?: { customerId: number; phone: string } | null;
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
  deliveryFree: boolean;
  deliveryWaivedAmount: string;
  total: string;
}

/** محرك التسعير الوحيد للـquote وللتثبيت؛ lineAmount يستعمل كمية السلة الفعلية. */
async function priceOnlineOrderLines(
  tx: Tx,
  branchId: number,
  lines: Array<Pick<OnlineOrderLineInput, "productUnitId" | "quantity">>,
  options: { lock: boolean; coupon?: LockedCoupon | null },
): Promise<PricedOnlineOrderLine[]> {
  const unitIds = Array.from(
    new Set(lines.map((line) => Number(line.productUnitId))),
  ).sort((a, b) => a - b);
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
      isCustomizable: products.isCustomizable,
      price: productPrices.price,
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
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !row ||
      !row.productActive ||
      !row.showInStore ||
      (row.categoryId != null &&
        (!row.categoryActive || !row.categoryShowInStore)) ||
      row.isService ||
      !row.variantActive ||
      !row.unitActive ||
      !row.unitAvailableInStore ||
      row.price == null
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
    // عقد الطلب الحالي يثبت productUnitId/quantity فقط ويدمج تكرار الوحدة. قبول منتج مخصص
    // هنا سيحوّل خيارات الطباعة/الهدية إلى notes غير مسعّرة وغير مرتبطة بالسطر، ويمكن لعميل
    // معدّل حذفها أو دمج تخصيصين مختلفين. نفشل مغلقاً إلى أن يُضاف selectionDetails بنيوي
    // مُتحقق منه ومُخزّن لكل onlineOrderItem، ولا نعامل النص الحر كعقد إنتاج.
    if (row.isCustomizable === true) {
      throw new TRPCError({
        code: options.lock ? "CONFLICT" : "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر طلب «${row.productName}» عبر المتجر`,
          why: "هذا الصنف يحتاج اختياراتِ تخصيص (مقاس أو تصميم أو نصّ طباعة) لا يستقبلها الطلب الإلكتروني بعد، وطلبُه بلا اختياراتك يُنتج شيئاً غير الذي تريد",
          doThis:
            "احذفه من السلّة وأكمِل بقيّة الطلب، وتواصل معنا لإتمام الصنف المخصَّص باختياراتك",
        }),
      });
    }
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
    const priceAfterAutomatic = round2(
      retail.minus(automaticDiscount).lt(0)
        ? money(0)
        : retail.minus(automaticDiscount),
    );
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
    const couponDiscount = couponPromo
      ? money(couponPromo.discountForUnit)
      : money(0);
    const discount = automaticDiscount.plus(couponDiscount).gt(retail)
      ? retail
      : automaticDiscount.plus(couponDiscount);
    const unitPrice = round2(
      retail.minus(discount).lt(0) ? money(0) : retail.minus(discount),
    );
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
async function resolveDeliveryFee(
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

async function totalOnlineOrderQuote(
  tx: Tx,
  items: Array<{ lineTotal: string }>,
  governorate: string,
  freeShippingThreshold: string | null | undefined,
): Promise<
  Pick<
    OnlineOrderQuoteResult,
    | "subtotal"
    | "deliveryFee"
    | "deliveryFree"
    | "deliveryWaivedAmount"
    | "total"
  >
> {
  const subtotal = round2(sumMoney(items.map((item) => item.lineTotal)));
  const actualDeliveryFee = await resolveDeliveryFee(tx, governorate);
  let customerDeliveryFee = actualDeliveryFee;
  const freeThreshold = freeShippingThreshold
    ? money(freeShippingThreshold)
    : null;
  const deliveryFree = Boolean(
    freeThreshold && freeThreshold.gt(0) && subtotal.gte(freeThreshold),
  );
  if (deliveryFree) customerDeliveryFee = round2(money(0));
  return {
    subtotal: subtotal.toFixed(2),
    deliveryFee: customerDeliveryFee.toFixed(2),
    deliveryFree,
    deliveryWaivedAmount: deliveryFree ? actualDeliveryFee.toFixed(2) : "0.00",
    total: round2(subtotal.plus(customerDeliveryFee)).toFixed(2),
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
      const items = await priceOnlineOrderLines(
        tx,
        context.branchId,
        normalizedLines,
        { lock: false, coupon: lockedCoupon },
      );
      const couponDiscountTotal = round2(
        items.reduce(
          (sum, item) =>
            sum.plus(
              money(item.couponDiscountPerUnit ?? "0").times(item.quantity),
            ),
          money(0),
        ),
      );
      if (lockedCoupon && couponDiscountTotal.lte(0))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `تعذّر تطبيق الكوبون «${lockedCoupon.code}»`,
            why: "لا صنف في سلّتك يشمله هذا الكوبون، فخصمُه صفر",
            doThis:
              "أزِل الكوبون لإتمام الطلب بالسعر المعروض، أو أضِف صنفاً يشمله العرض",
          }),
        });
      const totals = await totalOnlineOrderQuote(
        tx,
        items,
        input.governorate,
        settings?.freeShippingThreshold,
      );
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
    },
    { gate: "NONE" },
  );
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

    // ② لقطة تسعير أولية لبناء متطلبات الأقفال. التثبيت المالي الوحيد أدناه يعيد
    // تشغيل المحرك نفسه بقراءة current مقفلة بعد قفل الوحدات.
    const items = await priceOnlineOrderLines(tx, branchId, normalizedLines, {
      lock: false,
      coupon: lockedCoupon,
    });
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
    const currentItems = await priceOnlineOrderLines(
      tx,
      branchId,
      normalizedLines,
      { lock: true, coupon: lockedCoupon },
    );
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
    const couponDiscount = round2(
      items.reduce(
        (sum, item) =>
          sum.plus(
            money(item.couponDiscountPerUnit ?? "0").times(item.quantity),
          ),
        money(0),
      ),
    );
    if (lockedCoupon && couponDiscount.lte(0))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تطبيق الكوبون «${lockedCoupon.code}»`,
          why: "لا صنف في سلّتك يشمله هذا الكوبون، فخصمُه صفر",
          doThis:
            "أزِل الكوبون لإتمام الطلب بالسعر المعروض، أو أضِف صنفاً يشمله العرض",
        }),
      });
    const quoteTotals = await totalOnlineOrderQuote(
      tx,
      items,
      input.governorate,
      storeSettings?.freeShippingThreshold,
    );
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
            why: // ⚠️ «الحجوزات النشطة» **عبارةٌ متعاقَدٌ عليها**: يطابقها
            // `onlineOrderAvailability.test.ts` على فرع الكمية (اختبار ATP بعد الحجوزات).
            // أسقطتُها أوّلَ صياغةٍ ففُقد التعاقد بلا خطأ نوعٍ ولا تحذير — يمسكه مسحُ الانجراف.
            "الكمية المطلوبة من أحد أصناف سلّتك أكثر من المتوفّر الآن بعد احتساب الحجوزات النشطة وطلبات زبائن آخرين",
            doThis:
              "أنقص الكمية أو احذف الصنف ثمّ أعد المحاولة، أو تواصل معنا لنحجزه لك حين يصل",
          }),
        });
      }
    }

    // ④ إنشاء الطلب (PENDING) — رقمٌ مؤقّت فريد ثم ORD-{id} (بلا سباق ترقيم).
    const guestTrackingPublicId = randomBytes(16).toString("hex");
    const guestTrackingExpiresAt = new Date(
      Date.now() + GUEST_TRACKING_TTL_SECONDS * 1000,
    );
    const guestTrackingToken = buildGuestTrackingToken(
      guestTrackingPublicId,
      guestTrackingExpiresAt,
    );
    const insOrder = await tx.insert(onlineOrders).values({
      orderNumber: `TMP-${randomUUID()}`,
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
      governorate: input.governorate,
      latitude: input.latitude != null ? String(input.latitude) : null,
      longitude: input.longitude != null ? String(input.longitude) : null,
      clientRequestId: input.clientRequestId ?? null,
      guestTrackingPublicId,
      guestTrackingTokenHash: hashGuestTrackingToken(guestTrackingToken),
      guestTrackingExpiresAt,
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
    if (lockedCoupon) {
      await reserveCouponForOnlineOrder(tx, lockedCoupon, {
        onlineOrderId: orderId,
        customerId,
        branchId,
        discountAmount: couponDiscount.toFixed(2),
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
  subtotal: string;
  deliveryFee: string;
  deliveryFree: boolean;
  deliveryWaivedAmount: string;
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
    deliveryFree: order.deliveryFree === true,
    deliveryWaivedAmount: String(order.deliveryWaivedAmount ?? "0"),
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

function trackingHeaderSelection() {
  return {
    id: onlineOrders.id,
    orderNumber: onlineOrders.orderNumber,
    status: onlineOrders.status,
    subtotal: onlineOrders.subtotal,
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
        status: onlineOrders.status,
        subtotal: onlineOrders.subtotal,
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
