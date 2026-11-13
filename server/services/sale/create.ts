// إنشاء فاتورة بيع ذرّياً: idempotency + تسعير/تحويل الأسطر + بوّابة أقل-من-التكلفة +
// تقريب نقدي IQD + حدّ الائتمان + خصم المخزون + قيد SALE + الدفعة/الذمم.
import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  couponRedemptions,
  coupons,
  customers,
  deliveryConsignments,
  deliveryParties,
  invoiceItemBundleComponents,
  invoiceItemServiceMaterials,
  invoiceItems,
  invoices,
  openingModeSettings,
  productUnits,
  productVariants,
  products,
  promotions,
  receipts,
  shifts,
} from "../../../drizzle/schema";
import { dispatchInvoiceInTx } from "../delivery/dispatchInvoice";
import {
  assertDeliveryFeeHeldConsistent,
  recordDeliveryFeeHeldInTx,
} from "../delivery/feeHeld";
import {
  computeInvoiceCost,
  computeInvoiceTotals,
  computeLineTotal,
  isInvoiceBelowCost,
  invoiceDiscountExceedsThreshold,
  lineDiscountExceedsThreshold,
  MANUAL_DISCOUNT_APPROVAL_THRESHOLD,
  snapshotUnitCost,
} from "../billing";
import { assertCreditLimit } from "../../lib/credit";
import { extractInsertId } from "../../lib/insertId";
import { consumeApproval, validateApproval } from "../creditApprovalService";
import {
  bundleDefinitionsFingerprint,
  computeBundleUnitCosts,
  getBundleDefinitions,
  type VariantKind,
} from "../bundleService";
import { GIFT_APPROVAL_THRESHOLD } from "../gifts/outbound";
import { applyMovement, convertToBaseQuantity } from "../inventoryService";
import { addQuantities } from "@shared/quantity";
import { lockInventoryVariants } from "../inventory/stockLock";
import { assertEconomicInventoryRepostScope } from "../inventory/economicOwnership";
import { assertStockedOwnedMaterials } from "../inventory/materialEligibility";
import { resolveContractPrices } from "../contractPriceService";
import {
  allocateCouponDiscountAcrossLines,
  loadPromotionRuleSnapshot,
  resolvePromotionForLine,
  snapshotToEngineRules,
} from "../salesPromotionService";
import {
  evaluateCartPromotions,
  type CartEvalItem,
} from "../../../shared/promotionEngine";
import {
  consumeCoupon,
  hashCouponCode,
  issueBounceBackCouponTx,
  lockCouponForSale,
} from "../couponService";
import {
  adjustCustomerBalance,
  adjustSupplierBalance,
  computeInvoiceStatus,
  postEntry,
} from "../ledgerService";
import { autoSettleCustomerAccountTx } from "../reconciliation/autoSettlementService";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  signedPostingLines,
  type AccountRole,
  type PostingProfile,
} from "../accounting/postingEngine";
import { logger } from "../../logger";
import { clampMoney, money, round2, roundCashIQD, toDbMoney } from "../money";
import { nextInvoiceNumber, nextTransactionTrackingNumber } from "../numbering";
import { formatDocumentNumber, stripDocPrefix } from "@shared/documentNumber";
import {
  getUnitPrice,
  tryGetUnitPrice,
  resolveTier,
  type PriceTier,
} from "../pricing";
import { type Actor, requireDb, withTx } from "../tx";
import type { Tx } from "../../db";
import { flowNotify } from "../whatsapp";
import { readOpeningWindowState } from "../openingModeService";
import { classifyGiftPosting } from "./giftPosting";
import { mixedAwarePaymentMethod } from "./payment";
import { paymentAssetRole } from "./paymentPosting";
import { userNameSnapshot } from "../userSnapshot";
import { assertPosPaymentMethodEnabled } from "../posPaymentPolicy";
import { lockMaterializedCashReceiptSourceForWrite } from "../cash/cashAvailability";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import {
  discoverServiceRecipeDefinitions,
  exactRecipeMaterialQuantity,
  SERVICE_RECIPE_CONSUMPTION_NOTE,
  serviceRecipeDefinitionsFingerprint,
} from "../serviceRecipeConsumption";
import type { CreateSaleInput, CreateSaleResult } from "./types";
import { titleForChannel } from "@shared/productChannelTitles";
import { appErrorMessage } from "@shared/errors";
import {
  resolveSaleAttribution,
  recordInvoiceAttributionsInTx,
} from "../commissions/attribution";

// قنوات الاستقبال/التنفيذ المشمولة بإعفاء الائتمان في «وضع الافتتاح» (قرار المالك ١٠/٨):
// البيع المباشر (POS) والطلبات (ORDER) وأوامر الشغل (WORKORDER). ONLINE (المتجر) خارج النطاق.
const OPENING_RECEPTION_CHANNELS = new Set(["POS", "ORDER", "WORKORDER"]);

function saleDefinitionChangedError(why: string): string {
  return appErrorMessage({
    what: "تعذّر حفظ فاتورة البيع",
    why,
    doThis: "حدّث الأصناف ثم أعد إنشاء الفاتورة",
  });
}

/**
 * نواة البيع الذرّية — تعمل داخل معاملة موجودة.
 * تصدير داخلي فقط: يستعمله `createSale` (المغلّف) و`digitalCards.sales.finalize` (تركيب).
 * لا يُعرَض عبر الراوتر مباشرة.
 */
/** رمز غير قابل للإنشاء من حمولة tRPC؛ يفتح منتجات DIGITAL_CARD لمسار التثبيت الموثوق فقط. */
export const DIGITAL_SALE_CAPABILITY = Symbol("DIGITAL_SALE_CAPABILITY");
/** Completion of an exact, previously admitted digital credit intent; never supplied over JSON. */
export const VERIFIED_DIGITAL_CREDIT_PREFLIGHT = Symbol("VERIFIED_DIGITAL_CREDIT_PREFLIGHT");

/**
 * م١ (PR-1) — البيعُ بتوصيلٍ بيعٌ COD **خادمياً**: يُشتقّ العلمان من وجود `delivery` وحده، فلا
 * يحتاج أيُّ مستدعٍ (الراوتر، تركيب البطاقات، الحجز…) أن يتذكّر ضبطَهما — نسيانُهما هو الجذر
 * الذي كان يجعل الاستقبال يرفض توصيلَ عميلٍ جديد بحدّ «0» بينما المتجر يقبله.
 *
 * ⛔ الأوفلاين: `sales.create` هدفُ إعادة تشغيل الطابور (`offline/replaySale.ts`)، والإسناد
 * يحتاج حرّاس الجهة الحيّة (سقف العهدة وعمر الطرود المفتوحة) ورقمَ إرسالية ووردية درجٍ للأمانة —
 * لا شيء منها يصحّ لبيعٍ التُقط دون اتصال. يُرفض قبل أيّ قراءةٍ من القاعدة.
 */
function withDeliveryDefaults(input: CreateSaleInput): CreateSaleInput {
  const hasDelivery = input.delivery != null;
  const hasFeeHeld = money(input.deliveryFeeHeld ?? "0").gt(0);
  if (!hasDelivery && !hasFeeHeld) return input;
  if (input.offlineCapture) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إسناد البيع للتوصيل من طابور الأوفلاين",
        why: "الإسناد يحتاج حرّاس الجهة الحيّة (سقف العهدة وعمر الطرود المفتوحة) ورقمَ إرسالية ووردية درجٍ لأمانة الأجرة، ولا يتوفّر شيءٌ منها لبيعٍ التُقط دون اتصال",
        doThis:
          "أعِد تشغيل البيع من الطابور بلا توصيل، ثمّ أسنِد فاتورته لجهة التوصيل من شاشة الإرساليات بعد عودة الاتصال",
      }),
    });
  }
  // Codex #1006 P1 — أمانةُ أجرةٍ بلا توصيلٍ في نفس البيع = أمانةٌ يتيمة: لا إرساليّةَ تُبرّئها،
  // فإلغاءُ الفاتورة قبل أيّ إسنادٍ لاحق يعاملها `cancelSaleInTx` إيصالَ بيعٍ عاديّاً فيردّها
  // `PAYMENT_OUT` ويترك التزام `DELIVERY_FEE_HELD` غير معكوسٍ ويُفسِد `customers.currentBalance`.
  // نُلزم الإسنادَ في نفس البيع فلا تبقى أمانةٌ محجوزةٌ بلا مسار تبرئة (نصّ المالك: لا دينار بلا مسار).
  if (!hasDelivery) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر قبض أمانة أجرة التوصيل بلا إسناد توصيل",
        why: "أرسلت مبلغ أمانة أجرة توصيل دون بيانات توصيلٍ في نفس البيع؛ الأمانة المحجوزة تبقى بلا إرساليّةٍ تُبرّئها، فيعلق مالُ الزبون بلا مسار ردٍّ عند أيّ إلغاء",
        doThis:
          "أرسل بيانات التوصيل (الجهة والأجرة) مع الأمانة في نفس الطلب، أو احذف مبلغ الأمانة",
      }),
    });
  }
  return { ...input, codDispatchPending: true, paymentMode: "COD" };
}

export async function createSaleInTx(
  tx: Tx,
  rawInput: CreateSaleInput,
  actor: Actor,
  capability?: typeof DIGITAL_SALE_CAPABILITY,
): Promise<CreateSaleResult> {
  const input = withDeliveryDefaults(rawInput);
  // Codex #1006 P1 — `paymentMode` مُشتقٌّ من وجود `delivery` (COD) لا معلومةٌ مستقلّة، فإدراجُه في
  // بصمة idempotency يكسر تكرارَ بيعٍ التزم قبل نشر م١ (بصمتُه المخزَّنة بلا paymentMode) بـCONFLICT
  // بدل replay عبر النشر ⇒ يعيد الموظّف البيعَ بمفتاحٍ جديد = فاتورةٌ مكرَّرة. نستبعده من البصمة
  // وحدها؛ `delivery` نفسها فيها تحفظ التمييز، فحمايةُ «نفس المفتاح بحمولةٍ مختلفة» تبقى.
  const { paymentMode: _fingerprintExcludedPaymentMode, ...fingerprintInput } =
    input;
  const requestFingerprint = input.clientRequestId
    ? idempotencyHash(fingerprintInput)
    : null;
  const hasExplicitLegs =
    Array.isArray(input.payments) && input.payments.length > 0;
  const rawPaymentLegs = hasExplicitLegs
    ? input.payments!
    : input.payment
      ? [input.payment]
      : [];
  // نواة الفاتورة هي حدّ الأمان الأخير: لا نعتمد على راوتر أو marker لإثبات قبض خارجي.
  for (const leg of rawPaymentLegs) {
    assertPosPaymentMethodEnabled(leg.method);
    if (hasExplicitLegs && money(leg.amount).lte(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "تعذّر تثبيت الدفعات المقسّمة",
          why: "مبلغ كل دفعة مقسّمة يجب أن يكون أكبر من صفر",
          doThis: "أدخل مبلغاً موجباً لكل دفعة أو احذف الدفعة الفارغة",
        }),
      });
    }
    // ثابت «لا قبضَ بلا أثرٍ قابلٍ للمطابقة»: هذه النواة تُنشئ إيصالها بنفسها (بند ١٢ أدناه)
    // فلا يمرّ بحارس `sale/payment.ts`. كل مسارات البيع تصبّ هنا (الكاشير، المطبعة، تحويل
    // عرض السعر، الحجز، أمر الشغل)، فوَضعُ الشرط هنا يغلق الباب على كلّها مرّةً واحدة بدل
    // تكراره في كل مستدعٍ — والمرجع يأتي إمّا نصّاً من الموظّف أو من محاولةٍ مؤكَّدة
    // (createConfirmedPosSaleInTx يحقن مرجع المحاولة في الحمولة قبل بلوغ هذه النقطة).
    if (leg.method !== "CASH" && !(leg.reference ?? "").trim()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "مرجع عملية البطاقة/التحويل مطلوب",
      });
    }
  }
  if (input.preCollected?.method && capability !== DIGITAL_SALE_CAPABILITY) {
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({"what":"تعذّر ربط المقبوض السابق بالفاتورة","why":"تحديد وسيلة المقبوض السابق يتطلب تسوية رقمية موثقة","doThis":"استعد قرار تسوية القبض الرقمي من طابور المراجعة واعتمده أولاً"}) });
  }
  const effectiveInvoicePaymentMethod = rawPaymentLegs.reduce<string | null>(
    (acc, leg) => mixedAwarePaymentMethod(acc, leg.method),
    input.preCollected?.method ?? null,
  );
  // This namespace is generated only by the trusted digital-card finalizer.  Check it
  // before idempotency lookup so a public POS request cannot replay an existing
  // digital invoice merely by guessing its sourceId.
  if (
    capability !== DIGITAL_SALE_CAPABILITY &&
    input.clientRequestId?.startsWith("DIGITAL_INTENT:")
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مفتاح الطلب محجوز لمسار البطاقات الرقمية",
    });
  }
  // 1. Idempotency: replay the existing invoice for a repeated clientRequestId.
  //    SALES-04 (تدقيق ٢٣/٦/٢٦): البصمة كانت قاصرة على branchId ⇒ كاشير يُعيد استعمال المفتاح
  //    على بيع مختلف فيستلم فاتورة بيعٍ سابق ولا يُسجَّل البيع الجديد ⇒ منفذ سرقة نقد. الحلّ على
  //    نمط processPayment/voucherService: نتحقّق من (branch, customer, payment.method, عدد الأسطر)
  //    قبل إرجاع الفاتورة القديمة، وإلا CONFLICT صريح يُظهر للمستخدم أن المفتاح يخصّ بيعاً مغايراً.
  if (input.clientRequestId) {
    await checkIdempotency(
      tx,
      "sale.create",
      input.clientRequestId,
      requestFingerprint,
    );
    const existing = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.sourceId, input.clientRequestId))
      .limit(1);
    if (existing[0]) {
      const ex = existing[0];
      // SALES-03: عزل الفرع — مفتاح idempotency يخصّ بيع فرع آخر لا يُكشَف للمستخدم (تعارض، لا تسريب فاتورة).
      if (Number(ex.branchId) !== input.branchId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "مفتاح idempotency مستعمَل لبيع فرع آخر",
        });
      }
      const requestedCustomerId = input.customerId ?? null;
      const storedCustomerId =
        ex.customerId != null ? Number(ex.customerId) : null;
      if (storedCustomerId !== requestedCustomerId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تعارض idempotency: المفتاح مستعمَل لبيع عميل مختلف",
        });
      }
      const requestedMethod = effectiveInvoicePaymentMethod;
      if ((ex.paymentMethod ?? null) !== requestedMethod) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تعارض idempotency: المفتاح مستعمَل لبيع بطريقة دفع مختلفة",
        });
      }
      // SALES-04b (تدقيق ٢/٧): البصمة كانت تقارن «عدد» الأسطر فقط ⇒ بيع مختلف بنفس عدد الأصناف
      // يُصادَر بفاتورة قديمة بصمت (منفذ سرقة نقد: النقد يُقبض ولا يُسجَّل). الآن نقارن **محتوى**
      // الأسطر (الصنف + الوحدة + الكمية) كمجموعة مرتّبة. لا نقارن السعر/الخصم عمداً كي لا نُطلق
      // تعارضاً زائفاً عند إعادة محاولة نفس البيع بعد تغيّر تسعيرة — الصنف+الوحدة+الكمية بصمة كافية.
      const existingItems = await tx
        .select({
          variantId: invoiceItems.variantId,
          productUnitId: invoiceItems.productUnitId,
          quantity: invoiceItems.quantity,
        })
        .from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, ex.id));
      const lineKey = (
        variantId: number | null,
        unitId: number | null,
        quantity: string,
      ) =>
        `${Number(variantId)}:${unitId == null ? "" : Number(unitId)}:${money(quantity).toFixed(3)}`;
      const existingKeys = existingItems
        .map((i) =>
          lineKey(
            Number(i.variantId),
            i.productUnitId == null ? null : Number(i.productUnitId),
            i.quantity,
          ),
        )
        .sort();
      const requestedKeys = input.lines
        .map((l) => lineKey(l.variantId, l.productUnitId, l.quantity))
        .sort();
      if (existingKeys.length !== requestedKeys.length) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تعارض idempotency: المفتاح مستعمَل لبيع بعدد أصناف مختلف",
        });
      }
      if (existingKeys.some((k, i) => k !== requestedKeys[i])) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "تعارض idempotency: المفتاح مستعمَل لبيع بأصناف أو كميات مختلفة",
        });
      }
      // الكوبون جزء من بصمة البيع: لا يجوز لمفتاح إعادة المحاولة نفسه تبديل الكوبون أو إسقاطه.
      const redemption = (
        await tx
          .select({ codeHash: coupons.codeHash })
          .from(couponRedemptions)
          .innerJoin(coupons, eq(couponRedemptions.couponId, coupons.id))
          .where(eq(couponRedemptions.invoiceId, ex.id))
          .limit(1)
      )[0];
      const requestedCouponHash = input.couponCode
        ? hashCouponCode(input.couponCode)
        : null;
      if ((redemption?.codeHash ?? null) !== requestedCouponHash) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تعارض idempotency: الكوبون مختلف عن البيع الأصلي",
        });
      }
      // م١ (PR-1): الإرسالية أُنشئت مع الفاتورة في المحاولة الفائزة — تعود مع الإعادة كي يحمل
      // الإيصال المطبوع رقمَها (لا يُعاد الإسناد؛ الفاتورة الواحدة إرساليةٌ واحدة بقيدٍ فريد).
      const replayConsignment = input.delivery
        ? (
            await tx
              .select({
                id: deliveryConsignments.id,
                consignmentNumber: deliveryConsignments.consignmentNumber,
              })
              .from(deliveryConsignments)
              .where(eq(deliveryConsignments.invoiceId, Number(ex.id)))
              .limit(1)
          )[0]
        : undefined;
      const preIds = new Set(input.preCollected?.receiptIds ?? []);
      const replayReceipts = (
        await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(
            and(
              eq(receipts.invoiceId, Number(ex.id)),
              eq(receipts.direction, "IN"),
            ),
          )
          .orderBy(receipts.id)
      )
        .map((r) => Number(r.id))
        .filter((id) => !preIds.has(id));
      return {
        invoiceId: Number(ex.id),
        invoiceNumber: ex.invoiceNumber,
        // G3 (١١/٨): shiftId المُثبَّت على الفاتورة الأصليّة — لا shiftId الحاليّ للفاعل. الإعادة
        // الـidempotent بعد إغلاق وردية وفتح أخرى تحتاج هذا لكي يطبع الإيصال الوردية الحقيقيّة
        // للمعاملة (Codex P2 على PR #553).
        shiftId: ex.shiftId ?? null,
        total: ex.total,
        status: ex.status as CreateSaleResult["status"],
        createdReceiptId: replayReceipts[0] ?? null,
        createdReceiptIds: replayReceipts,
        idempotentReplay: true,
        ...(replayConsignment
          ? {
              consignmentId: Number(replayConsignment.id),
              consignmentNumber: replayConsignment.consignmentNumber,
            }
          : {}),
      };
    }
  }

  if (!input.lines.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يمكن إنشاء فاتورة بلا أصناف",
    });
  }

  // 2. Shift must be OPEN and belong to the branch (when provided — POS).
  //    .for("update") يُسَلْسِل البيع مع closeShift على نفس الصفّ ⇒ إمّا يقفل البيع قبل
  //    الإغلاق ويُحتسَب، أو يُرفض إن سبق الإغلاق فلا يدخل receipt بعد قطع الـZ-report.
  const isCashPayment = rawPaymentLegs.some(
    (leg) => leg.method === "CASH" && money(leg.amount ?? "0").gt(0),
  );
  if (isCashPayment && input.shiftId == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "يَلزم وردية مفتوحة للبيع النقدي",
    });
  }
  // م١ (PR-1): أمانةُ أجرة التوصيل إيصالُ درجٍ نقديّ — تلزمها وردية كالبيع النقديّ تماماً.
  const writesFeeHeldCash =
    money(input.deliveryFeeHeld ?? "0").gt(0) &&
    (input.deliveryFeeTender?.method ?? "CASH") === "CASH";
  if (writesFeeHeldCash && input.shiftId == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر قبض أمانة أجرة التوصيل",
        why: "الأمانة تدخل درج الوردية نقداً، ولا وردية مفتوحة مرفقة بهذا البيع",
        doThis:
          "افتح وردية باسمك من شاشة الورديات ثمّ أعد البيع، أو اجعل أجرة التوصيل على المندوب (COURIER) بلا أمانة",
      }),
    });
  }
  if (input.shiftId) {
    const s = await tx
      .select()
      .from(shifts)
      .where(eq(shifts.id, input.shiftId))
      .for("update")
      .limit(1);
    if (!s[0] || Number(s[0].branchId) !== input.branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الوردية غير مفتوحة أو لا تخص هذا الفرع",
      });
    }
    if (s[0].status !== "OPEN") {
      // الإقفال حدّ محاسبي غير قابل للكتابة بأثر رجعي. يبقى البيع الأوفلايني في طابور
      // المراجعة ويُسوّى من مسار إداري لاحق، ولا يعدّل expected/count لوردية مقفلة.
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "الوردية مغلقة — لا يمكن ترحيل بيع إليها بعد الإقفال. حوّل العملية إلى مراجعة التسوية اللاحقة.",
      });
    }
    // SHIFT-OWN (حظر انتحال الورديات - Fail-Closed): فرض ملكية الوردية للجميع بلا استثناء عند وجود حركة نقدية
    // يُمنع أي مستخدم (بما في ذلك المدير والأدمن) من تسجيل بيع نقدي على وردية مستخدم آخر.
    const hasCashMovement = isCashPayment || writesFeeHeldCash;
    const role = actor.role;
    const isDigitalSale = capability === DIGITAL_SALE_CAPABILITY;
    if (
      !isDigitalSale &&
      (hasCashMovement || (role !== "admin" && role !== "manager")) &&
      Number(s[0].userId) !== Number(actor.userId)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا تَستطيع التسجيل على وردية مستخدم آخر",
      });
    }
  }
  // م١ (PR-1): إيصال أمانة الأجرة يكتب نقدَ الدرج أيضاً ⇒ نفس القفل (مرآة `checkoutReception`).
  if (isCashPayment || writesFeeHeldCash) {
    await lockMaterializedCashReceiptSourceForWrite(tx, {
      branchId: input.branchId,
      shiftId: input.shiftId,
      cashBucket: "DRAWER",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
  }

  // 3. Resolve the effective price tier.
  let customerTier: PriceTier | null = null;
  if (input.customerId) {
    // قفل صفّ العميل: يُسلسِل البيوع الآجلة المتزامنة فلا يتجاوز اثنان حدّ الائتمان معاً.
    const c = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .for("update")
      .limit(1);
    if (!c[0])
      throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    customerTier = c[0].defaultPriceTier as PriceTier;
  }
  const tier = resolveTier({ override: input.priceTier ?? null, customerTier });

  // يوم بغداد هو مرجع صلاحية العرض والكوبون معاً؛ يُحسَب مرة واحدة داخل المعاملة.
  // M4 (F25): استخدام وقت الالتقاط الفعلي للبيع في وضع الأوفلاين إن وُجد لضمان ثبات صلاحية العروض
  const parsedCaptureDate = input.offlineCapture?.capturedAt
    ? new Date(input.offlineCapture.capturedAt)
    : null;
  const referenceDate =
    parsedCaptureDate && !Number.isNaN(parsedCaptureDate.getTime())
      ? parsedCaptureDate
      : new Date();
  const _bag = new Date(referenceDate.getTime() + 3 * 60 * 60 * 1000);
  const todayYmd = _bag.toISOString().slice(0, 10);
  const lockedCoupon = input.couponCode
    ? await lockCouponForSale(tx, {
        code: input.couponCode,
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        todayYmd,
      })
    : null;

  // 4. Price/cost/convert each line.
  // D1 (٣٠/٦): حلّ N+1 — قراءة كل المتغيّرات بـinArray دفعةً واحدةً قبل الحلقة بدل
  // round-trip لكل سطر. التكلفة لا تُقرأ هنا؛ تُلتقط لاحقاً بعد قفل اتحاد الأصناف
  // ومكوّنات البكج ومواد الخدمة، كي تطابق COGS حركة المخزون ذاتها.
  // قبل: ٢٠ سطر = ٢٠ استعلاماً متسلسلاً. بعد: استعلام واحد ⇒ زمن المعاملة ينخفض دراماتيكياً
  // ونافذة الأقفال على shifts/customers تَنكمش (انكماش هذه النافذة = أقلّ تنافس عند الذروة).
  const uniqueVariantIds = Array.from(
    new Set(input.lines.map((l) => l.variantId)),
  );
  const variantRows = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      isActive: productVariants.isActive,
      isService: products.isService,
      isBundle: products.isBundle,
      productType: products.productType,
      stockUsage: products.stockUsage,
      productName: products.name,
      invoiceLabel: products.invoiceLabel,
      shortTitle: products.shortTitle,
      // تدقيق ١١/٨ (H4): تعطيل المنتج نفسه يجب أن يمنع البيع أيضاً — كان الحارس يفحص المتغيّر فقط،
      // فمنتجٌ عطّله المالك بمتغيّراتٍ نشطة يظلّ يُباع خادمياً عبر API/سلة قديمة/إعادة تشغيل أوفلاين.
      productActive: products.isActive,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(inArray(productVariants.id, uniqueVariantIds));
  const variantById = new Map<
    number,
    {
      productId: number;
      costPrice: string;
      isActive: boolean | null;
      productType: string | null;
      stockUsage: typeof products.$inferSelect.stockUsage;
      productActive: boolean | null;
      productName: string;
      invoiceLabel: string | null;
      shortTitle: string | null;
    }
  >();
  for (const r of variantRows) {
    variantById.set(Number(r.id), {
      productId: Number(r.productId),
      costPrice: "0",
      isActive: r.isActive,
      productType: r.productType ?? null,
      stockUsage: r.stockUsage ?? null,
      productActive: r.productActive,
      productName: r.productName,
      invoiceLabel: r.invoiceLabel ?? null,
      shortTitle: r.shortTitle ?? null,
    });
  }
  if (variantById.size !== uniqueVariantIds.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر تثبيت أصناف الفاتورة",
        why: "أحد المتغيّرات غير موجود أو حُذف أثناء تجهيز البيع",
        doThis: "حدّث شاشة البيع واختر الأصناف مجدداً",
      }),
    });
  }

  // اكتشاف تعريفات البكج/الخدمة قبل الأقفال لا يتخذ قراراً مالياً؛ غايته فقط بناء
  // اتحاد الأقفال الكامل. بعد القفل نعيد القراءة ونقارن البصمة، فتكون النتيجة إما
  // التعريف القديم كاملاً أو الجديد كاملاً، ولا تُخصم وصفة هجينة تحت ضغط متزامن.
  const discoveredKindByVariant = new Map<number, VariantKind>();
  for (const row of variantRows) {
    discoveredKindByVariant.set(
      Number(row.id),
      row.isBundle ? "BUNDLE" : row.isService ? "SERVICE" : "STOCKED",
    );
  }
  const discoveredBundleVariantIds = uniqueVariantIds.filter(
    (variantId) => discoveredKindByVariant.get(variantId) === "BUNDLE",
  );
  let bundleDefs = await getBundleDefinitions(tx, discoveredBundleVariantIds);
  const discoveredServiceVariantIds = uniqueVariantIds.filter(
    (variantId) => discoveredKindByVariant.get(variantId) === "SERVICE",
  );
  let serviceDefinitions = await discoverServiceRecipeDefinitions(
    tx,
    discoveredServiceVariantIds,
  );
  const discoveredNestedVariantIds = [
    ...Array.from(bundleDefs.values()).flatMap((rows) =>
      rows.map((row) => row.componentVariantId),
    ),
    ...Array.from(serviceDefinitions.values()).flatMap((definition) =>
      definition.lines.map((line) => line.inputVariantId),
    ),
  ];
  const fullScopeVariantIds = Array.from(
    new Set([...uniqueVariantIds, ...discoveredNestedVariantIds]),
  ).sort((a, b) => a - b);
  const scopeRefs = await tx
    .select({ id: productVariants.id, productId: productVariants.productId })
    .from(productVariants)
    .where(inArray(productVariants.id, fullScopeVariantIds))
    .orderBy(productVariants.id);
  if (scopeRefs.length !== fullScopeVariantIds.length) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذّر تثبيت نطاق مخزون الفاتورة",
        why: "مكوّن بكج أو مادة خدمة تغيّر أو حُذف أثناء تجهيز البيع",
        doThis: "أعد المحاولة بعد تحديث شاشة البيع وتعريفات الوصفات",
      }),
    });
  }
  // نقفل صفوف المنتجات نفسها قبل اتخاذ أي قرار نوع/تفعيل. قفل المتغيّرات وحده لا يمنع
  // تعديل isService/isBundle/isActive المتزامن، وكان يسمح بأن يُسعّر السطر كخدمة ثم يُخصم
  // كبضاعة (أو العكس). القراءة القفلية هنا هي المصدر الحاكم لكل التصنيفات التالية.
  assertEconomicInventoryRepostScope(tx, fullScopeVariantIds);
  const lineProductIds = Array.from(
    new Set(scopeRefs.map((row) => Number(row.productId))),
  ).sort((a, b) => a - b);
  const lockedProducts = lineProductIds.length
    ? await tx
        .select({
          id: products.id,
          categoryId: products.categoryId,
          isActive: products.isActive,
          isService: products.isService,
          isBundle: products.isBundle,
          productType: products.productType,
          stockUsage: products.stockUsage,
          name: products.name,
          invoiceLabel: products.invoiceLabel,
          shortTitle: products.shortTitle,
        })
        .from(products)
        .where(inArray(products.id, lineProductIds))
        .orderBy(products.id)
        .for("update")
    : [];
  const lockedProductById = new Map(
    lockedProducts.map((p) => [Number(p.id), p]),
  );
  const kindByVariant = new Map<number, VariantKind>();
  for (const [variantId, variant] of Array.from(variantById.entries())) {
    const product = lockedProductById.get(variant.productId);
    if (!product) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّر تحميل منتج المتغيّر #${variantId}`,
          why: "سجل المنتج غير موجود أو حُذف أثناء تجهيز الفاتورة",
          doThis: "حدّث شاشة البيع واختر الصنف مجدداً",
        }),
      });
    }
    variant.productActive = product.isActive;
    variant.productType = product.productType ?? null;
    variant.stockUsage = product.stockUsage ?? null;
    variant.productName = product.name;
    variant.invoiceLabel = product.invoiceLabel ?? null;
    variant.shortTitle = product.shortTitle ?? null;
    kindByVariant.set(
      variantId,
      product.isBundle ? "BUNDLE" : product.isService ? "SERVICE" : "STOCKED",
    );
  }
  for (const variantId of uniqueVariantIds) {
    if (
      kindByVariant.get(variantId) !== discoveredKindByVariant.get(variantId)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تغيّر تصنيف الصنف #${variantId} أثناء تجهيز الفاتورة`,
          why: "تحول الصنف بين خدمة أو بكج أو مخزون بعد اكتشاف نطاق المواد",
          doThis:
            "حدّث شاشة البيع ثم أعد العملية كي تُبنى على التصنيف الحالي كاملاً",
        }),
      });
    }
  }
  const containsDigitalCard = Array.from(variantById.values()).some(
    (v) => v.productType === "DIGITAL_CARD",
  );
  if (containsDigitalCard && capability !== DIGITAL_SALE_CAPABILITY) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "البطاقات الرقمية تُباع من مسار الإصدار المخصّص فقط — لا تُضاف كصنف عادي",
    });
  }
  // A prepared ordinary product may have been reclassified since preparation.
  // Every actual digital row still needs a trusted intent cost and detail token.
  if (
    capability === DIGITAL_SALE_CAPABILITY &&
    input.lines.some(
      (line) =>
        variantById.get(line.variantId)?.productType === "DIGITAL_CARD" &&
        (line.unitCostOverride == null || !line.internalLineToken?.trim()),
    )
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تثبيت بند رقمي في السلة",
        why: "البند لا يحمل لقطة تكلفة وربطاً موثقاً بنيّة إصدار الكروت؛ ربما تغيّر تصنيف الصنف بعد إعداد السلة",
        doThis:
          "أوقف التثبيت وراجِع تصنيف الصنف والنيّة المحفوظة؛ لا تُعِد إصدار الكروت",
      }),
    });
  }
  if (
    input.lines.some(
      (line) =>
        line.unitCostOverride != null &&
        (capability !== DIGITAL_SALE_CAPABILITY ||
          variantById.get(line.variantId)?.productType !== "DIGITAL_CARD"),
    )
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تثبيت تكلفة البيع",
        why: "التكلفة المفروضة مخصصة للكرت الرقمي الموثق فقط؛ الأصناف العادية تتبع تكلفة المخزون",
        doThis:
          "أعِد إتمام البيع من نقطة البيع؛ لا ترسل تكلفة يدوية مع البنود العادية",
      }),
    });
  }
  // بضاعة الأمانة (ش٣): خريطة variantId → consignorId للأصناف الموسومة أمانةً — لالتقاط التزام المودِع
  // لحظة البيع (قيد PURCHASE يتيم) ولاستثنائها من البيع بالسالب في المسار الحيّ. راجع design §٢-ب/§٥-ج.
  const consignByVariant = new Map<number, number>();
  {
    const crows = await tx
      .select({
        vid: productVariants.id,
        isConsign: products.isConsignment,
        cId: products.consignorId,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, uniqueVariantIds));
    for (const r of crows)
      if (r.isConsign && r.cId != null)
        consignByVariant.set(Number(r.vid), Number(r.cId));
  }

  // بند 12ب (٧/٧): الأسعار التعاقدية النشطة للعميل — استعلام واحد (نمط D1 نفسه، لا N+1).
  // أسبقية اختيار السعر تتبع البنية القائمة حرفياً: override صريح (سعرٌ قصده المستخدم ويعرضه
  // للزبون — POS يثبّته دائماً، وحارس أقل-من-التكلفة يحكمه) ← السعر التعاقدي ← سعر الفئة.
  // نفس `resolveContractPrices` تغذّي عرض POS في catalog/pos.ts ⇒ نقطة العرض = نقطة الفرض.
  const contractPrices = input.customerId
    ? await resolveContractPrices(
        tx,
        input.customerId,
        input.lines.map((l) => l.productUnitId),
      )
    : new Map<number, string>();

  // bundles (٧/٧/٢٦): تصنيف المتغيّرات لتوجيه منطق التكلفة والمخزون. متغيّر BUNDLE:
  //   * تُحسب unitCost = Σ(componentCost × componentBaseQty) بدلاً من snapshotUnitCost(v.costPrice).
  //   * لا يُطبَّق applyMovement على المتغيّر نفسه (لا branchStock له) — يُطبَّق على مكوّناته لاحقاً.
  // القراءات دفعةً واحدة (لا N+1).
  const bundleVariantIds = discoveredBundleVariantIds;
  let bundleUnitCosts = new Map<number, string>();

  // الخدمة لا تملك مخزوناً ذاتياً: تكلفتها من مواد وصفة الاستهلاك، والمواد تُخصم فعلياً.
  // المحلّل المشترك يفشل مغلقاً عند وصفة معطلة/مكررة/فارغة ويتحقق أن مكوّناتها أصناف
  // مخزنية مملوكة ونشطة. وحدها الخدمة التي لم تُعرّف لها أي وصفة تاريخياً تُعدّ عمالة صرفة.
  const serviceVariantIds = discoveredServiceVariantIds;
  const materialCostByVariant = new Map<number, string>();
  const serviceMaterialIds = new Set<number>();
  for (const definition of Array.from(serviceDefinitions.values())) {
    for (const line of definition.lines) {
      serviceMaterialIds.add(line.inputVariantId);
    }
  }

  const bundleComponentIds = new Set<number>();
  for (const defs of Array.from(bundleDefs.values())) {
    for (const component of defs)
      bundleComponentIds.add(component.componentVariantId);
  }
  await lockInventoryVariants(tx, fullScopeVariantIds);

  // القراءات الثانية current reads بعد قفل كل المنتجات والمتغيّرات. كتّاب الوصفة والبكج
  // يقفلون النطاق ذاته؛ اختلاف البصمة يعني أن الاكتشاف سبق تحديثاً ملتزماً، فنطلب إعادة
  // المحاولة بدلاً من استخدام ids قديمة مع تعريف جديد.
  const currentBundleDefs = await getBundleDefinitions(tx, bundleVariantIds);
  if (
    bundleDefinitionsFingerprint(bundleDefs) !==
    bundleDefinitionsFingerprint(currentBundleDefs)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: saleDefinitionChangedError(
        "تغيّر تعريف أحد البكجات أثناء حفظ الفاتورة",
      ),
    });
  }
  bundleDefs = currentBundleDefs;
  const currentServiceDefinitions = await discoverServiceRecipeDefinitions(
    tx,
    serviceVariantIds,
  );
  if (
    serviceRecipeDefinitionsFingerprint(serviceDefinitions) !==
    serviceRecipeDefinitionsFingerprint(currentServiceDefinitions)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: saleDefinitionChangedError(
        "تغيّرت وصفة مواد إحدى الخدمات أثناء حفظ الفاتورة",
      ),
    });
  }
  serviceDefinitions = currentServiceDefinitions;
  await assertStockedOwnedMaterials(
    tx,
    Array.from(serviceMaterialIds),
    "مكوّن وصفة الخدمة",
  );
  await assertStockedOwnedMaterials(
    tx,
    Array.from(bundleComponentIds),
    "مكوّن البكج",
    { usageCheck: "sellable" },
  );
  const remainingGrandfathered = new Map<string, number>(
    input.grandfatheredRestrictedLineCaps
      ? Array.from(input.grandfatheredRestrictedLineCaps.entries())
      : [],
  );
  const serviceRecipe = new Map(
    Array.from(serviceDefinitions.entries()).map(([variantId, definition]) => [
      variantId,
      definition.lines,
    ]),
  );

  // كل لقطات التكلفة بعد mutex الحاكم: لا تستطيع إعادة تقييم أو WAVG أن تقع بين COGS
  // وبين خصم المخزون في الفاتورة نفسها.
  const lockedLineCosts = await tx
    .select({
      id: productVariants.id,
      cost: productVariants.costPrice,
      isActive: productVariants.isActive,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, uniqueVariantIds))
    .orderBy(productVariants.id)
    .for("update");
  if (lockedLineCosts.length !== uniqueVariantIds.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what: "تعذّر تثبيت أصناف الفاتورة",
        why: "أحد المتغيّرات حُذف أو لم يعد متاحاً أثناء الحفظ",
        doThis: "حدّث شاشة البيع وراجع الأصناف ثم أعد المحاولة",
      }),
    });
  }
  for (const r of lockedLineCosts) {
    const current = variantById.get(Number(r.id));
    if (current) {
      current.costPrice = String(r.cost ?? "0");
      current.isActive = r.isActive;
    }
  }
  bundleUnitCosts = await computeBundleUnitCosts(
    tx,
    bundleVariantIds,
    bundleDefs,
  );
  const componentIssueCosts = new Map<number, string>();
  if (bundleComponentIds.size) {
    const rows = await tx
      .select({ id: productVariants.id, cost: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, Array.from(bundleComponentIds)))
      .for("share");
    for (const row of rows) componentIssueCosts.set(row.id, row.cost);
  }
  if (serviceMaterialIds.size) {
    const matRows = await tx
      .select({ id: productVariants.id, cost: productVariants.costPrice })
      .from(productVariants)
      .where(inArray(productVariants.id, Array.from(serviceMaterialIds)));
    for (const r of matRows)
      materialCostByVariant.set(Number(r.id), String(r.cost ?? "0"));
  }
  // حارس صحّة: كل بكجٍ ورد كسطر بيع يجب أن يملك وصفة (على الأقل مكوّناً واحداً) — منتج بلا وصفة
  // مسجَّل isBundle=true بحادثة سيّئة (ملفَّق يدوياً أو حالة سباق). نرفض البيع صراحةً بدل حساب صفر.
  for (const bid of bundleVariantIds) {
    const list = bundleDefs.get(bid);
    if (!list || !list.length) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `البكج (متغيّر ${bid}) بلا مكوّنات — أضف مكوّناته قبل البيع`,
      });
    }
  }
  // Codex #163 P2 (Block bundles whose components were later disabled): إن عُطِّل مكوّن بعد إنشاء
  // البكج، البكج يبقى قابلاً للبيع بلا فحصٍ لحيويّة مكوّناته ⇒ يخصم مكوّناً معطَّلاً (يخالف B2 من
  // bundleService لكنّه لا يفرضه في مسار البيع). الآن نلتقط كل مكوّنات البكجات المُباعة دفعةً واحدة
  // ونرفض البيع لو أيٌّ منها معطَّل (منتج أو متغيّر).
  if (bundleVariantIds.length) {
    const allComponentIds = new Set<number>();
    for (const bid of bundleVariantIds) {
      for (const c of bundleDefs.get(bid) ?? [])
        allComponentIds.add(c.componentVariantId);
    }
    if (allComponentIds.size) {
      const componentRows = await tx
        .select({
          id: productVariants.id,
          variantActive: productVariants.isActive,
          productActive: products.isActive,
          productName: products.name,
          sku: productVariants.sku,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(productVariants.id, Array.from(allComponentIds)));
      for (const cr of componentRows) {
        if (cr.variantActive === false || cr.productActive === false) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `مكوّن بكج معطَّل: «${cr.productName} — ${cr.sku}» — فعّله أو استبدله قبل البيع`,
          });
        }
      }
    }
  }

  // promotions v2: تقييم العروض والكوبونات سلطوياً على مستوى السلة كاملة بلا N+1.
  void resolvePromotionForLine;
  let resolvedDeliveryFee: string | null = null;
  if (input.delivery) {
    resolvedDeliveryFee = input.delivery.fee ?? null;
    if (resolvedDeliveryFee == null) {
      const dp = (
        await tx
          .select({ defaultFee: deliveryParties.defaultFee })
          .from(deliveryParties)
          .where(eq(deliveryParties.id, input.delivery.partyId))
          .limit(1)
      )[0];
      resolvedDeliveryFee = dp?.defaultFee ?? "0";
    }
  }
  const hasShippingContext =
    Boolean(input.delivery) ||
    money(input.deliveryFee ?? "0").gt(0) ||
    input.deliveryFree === true;
  const linesNeedingPromo = input.lines.filter((l) => l.promotionId != null);
  const hasAnyPromoOrCoupon =
    linesNeedingPromo.length > 0 ||
    lockedCoupon != null ||
    (hasShippingContext && input.sourceType !== "ONLINE");
  const isBaseUnitByUnitId = new Map<number, boolean>();
  const promoMetaById = new Map<
    number,
    { id: number; allowBelowCost: boolean; isActive: boolean; name: string }
  >();
  if (hasAnyPromoOrCoupon) {
    const unitIdsForPromo = Array.from(
      new Set(input.lines.map((l) => l.productUnitId)),
    );
    if (unitIdsForPromo.length > 0) {
      const unitRowsForPromo = await tx
        .select({
          id: productUnits.id,
          isBaseUnit: productUnits.isBaseUnit,
        })
        .from(productUnits)
        .where(inArray(productUnits.id, unitIdsForPromo));
      for (const ur of unitRowsForPromo) {
        isBaseUnitByUnitId.set(Number(ur.id), Boolean(ur.isBaseUnit));
      }
    }

    const promoIds = Array.from(
      new Set([
        ...linesNeedingPromo.map((l) => Number(l.promotionId)).filter(Boolean),
        ...(lockedCoupon ? [lockedCoupon.promotionId] : []),
      ]),
    );
    if (promoIds.length > 0) {
      const promoRows = await tx
        .select({
          id: promotions.id,
          allowBelowCost: promotions.allowBelowCost,
          isActive: promotions.isActive,
          name: promotions.name,
        })
        .from(promotions)
        .where(inArray(promotions.id, promoIds));
      for (const pr of promoRows) {
        promoMetaById.set(Number(pr.id), pr);
      }
    }
  }
  const prePricedLines: Array<{
    l: (typeof input.lines)[number];
    v: NonNullable<ReturnType<typeof variantById.get>>;
    productId: number;
    categoryId: number | null;
    isBaseUnit: boolean;
    baseQuantity: number;
    contractPrice: string | undefined;
    refUnit: Decimal;
    unitPrice: Decimal;
    kind: VariantKind;
    serviceCost: {
      unitCost: string;
      lineCost: string;
      materials: Array<{
        materialVariantId: number;
        baseQuantity: number;
        unitCost: string;
        lineCost: string;
      }>;
    } | null;
    unitCost: string;
    lineCost: string;
    isGift: boolean;
    lineGross: Decimal;
  }> = [];
  for (const l of input.lines) {
    const v = variantById.get(l.variantId);
    if (!v)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `المتغيّر ${l.variantId} غير موجود`,
      });
    if (v.isActive !== true || v.productActive !== true) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `الصنف ${l.variantId} معطّل — لا يُباع`,
      });
    }

    const { baseQuantity } = await convertToBaseQuantity(
      tx,
      l.productUnitId,
      l.quantity,
      l.variantId,
    );
    const lineVariantMeta = variantById.get(l.variantId);
    const lineKind = kindByVariant.get(l.variantId) ?? "STOCKED";
    if (
      lineKind === "STOCKED" &&
      lineVariantMeta &&
      lineVariantMeta.stockUsage != null &&
      lineVariantMeta.stockUsage !== "SALE_ONLY" &&
      lineVariantMeta.stockUsage !== "SALE_AND_MATERIAL"
    ) {
      const capKey = `${l.variantId}:${l.productUnitId}`;
      const allowedCap = remainingGrandfathered.get(capKey) ?? 0;
      if (baseQuantity <= allowedCap) {
        remainingGrandfathered.set(capKey, allowedCap - baseQuantity);
      } else {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: `تعذّر بيع الصنف «${lineVariantMeta.productName}»`,
            why: "تصنيف استخدام الصنف المخزني لا يسمح بالبيع المباشر (مادة خام أو مستلزم تشغيل)، أو تجاوز التصحيحُ الوحدةَ أو الكميةَ الأصلية للفاتورة",
            doThis: "أزل الصنف غير المخصّص للبيع من الفاتورة أو التزم بوحدته وكميته الأصلية عند التصحيح",
          }),
        });
      }
    }
    const contractPrice = contractPrices.get(l.productUnitId);
    const hasOverride =
      l.unitPriceOverride != null && l.unitPriceOverride !== "";
    // المرجع للقياس (H6): عقد ← سعر القائمة (غير رامٍ) ← بلا مرجع. لا نُجبر وجود سعرٍ عند وجود override.
    const listRef =
      contractPrice != null
        ? money(contractPrice)
        : await tryGetUnitPrice(tx, l.productUnitId, tier);
    const refUnit = listRef ?? money(0);
    // السعر الفعليّ: override ← المرجع ← (بلا مرجعٍ ولا override) رميٌ محفوظ «عرّف السعر أولاً».
    const unitPrice = hasOverride
      ? money(l.unitPriceOverride!)
      : (listRef ?? (await getUnitPrice(tx, l.productUnitId, tier)));
    // bundles: تكلفة البكج محسوبة لحظياً من مجموع مكوّناته (لا `productVariants.costPrice`
    // لأن البكج نفسه بلا WAVG — تكلفته صافي مجموع مكوّناته الحيّ لحظة البيع، قرار مالك ٧/٧).
    const kind = kindByVariant.get(l.variantId) ?? "STOCKED";
    // §١٠.٣ (البطاقات الرقمية): تكلفة مفروضة خادمياً تتقدّم على `costPrice` — تُملأ حصراً من
    // نيّةٍ مقفولة في القاعدة (حصة المزوّد)، ولا يقبلها راوتر. راجع `SaleLineInput.unitCostOverride`.
    // الخدمة: unitCost يُحسب من الوصفة (لقطة كلفة المواد لحظة البيع) — لا من `variants.costPrice`
    // (الذي هو لقطة إدارية عرضية عند إنشاء الخدمة، يُحدَّث فقط بتعديل يدوي). المطابقة لمنطق
    // printSaleService.ts: لكل مادةٍ في الوصفة نحسب الاستهلاك الدقيق لكامل السطر، نضربه
    // بكلفتها، ثم unitCost = round2(Σ / baseQuantity). خدمةٌ
    // بلا وصفة ⇒ unitCost=0 (متسّق مع سياسة النقطة النقدية القائمة).
    const computeServiceCostSnapshot = () => {
      const rlines = serviceRecipe.get(l.variantId);
      if (!rlines || !rlines.length || baseQuantity <= 0) {
        return {
          unitCost: "0.00",
          lineCost: "0.00",
          materials: [] as Array<{
            materialVariantId: number;
            baseQuantity: number;
            unitCost: string;
            lineCost: string;
          }>,
        };
      }
      let lineCost = money(0);
      const byMaterial = new Map<
        number,
        {
          baseQuantity: number;
          unitCost: string;
          lineCost: ReturnType<typeof money>;
        }
      >();
      for (const rl of rlines) {
        const consumed = exactRecipeMaterialQuantity(
          rl.qtyPerOutputBase,
          baseQuantity,
          `مادة الوصفة #${rl.inputVariantId}`,
        );
        const matCost = round2(
          money(materialCostByVariant.get(rl.inputVariantId) ?? "0"),
        );
        const materialLineCost = round2(matCost.times(consumed));
        lineCost = lineCost.plus(materialLineCost);
        const current = byMaterial.get(rl.inputVariantId) ?? {
          baseQuantity: 0,
          unitCost: matCost.toFixed(2),
          lineCost: money(0),
        };
        current.baseQuantity = addQuantities(current.baseQuantity, consumed);
        current.lineCost = current.lineCost.plus(materialLineCost);
        byMaterial.set(rl.inputVariantId, current);
      }
      const exactLineCost = round2(lineCost);
      return {
        unitCost: round2(exactLineCost.div(baseQuantity)).toFixed(2),
        lineCost: exactLineCost.toFixed(2),
        materials: Array.from(byMaterial.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([materialVariantId, value]) => ({
            materialVariantId,
            baseQuantity: value.baseQuantity,
            unitCost: value.unitCost,
            lineCost: round2(value.lineCost).toFixed(2),
          })),
      };
    };
    const serviceCost =
      kind === "SERVICE" ? computeServiceCostSnapshot() : null;
    const unitCost =
      l.unitCostOverride != null
        ? snapshotUnitCost(l.unitCostOverride)
        : kind === "BUNDLE"
          ? snapshotUnitCost(bundleUnitCosts.get(l.variantId) ?? "0")
          : kind === "SERVICE"
            ? serviceCost!.unitCost
            : snapshotUnitCost(v.costPrice);
    // البطاقة الرقمية منتج SERVICE بلا وصفة عادةً، لكن تكلفتها ليست صفراً: حصة المزوّد
    // الموثقة في النيّة (`unitCostOverride`) تتقدّم على لقطة الوصفة في unitCost **وlineCost**.
    const lineCost =
      l.unitCostOverride != null
        ? round2(money(unitCost).times(baseQuantity)).toFixed(2)
        : kind === "SERVICE"
          ? serviceCost!.lineCost
          : round2(money(unitCost).times(baseQuantity)).toFixed(2);
    // هدايا الفاتورة (0149): السطر المُهدى مجّانيّ **بقرار خادميّ** — لا نثق بسعرٍ/خصمٍ وارد من
    // الشاشة. السعر صفر والخصم صفر (خصمٌ على مجّانٍ لا معنى له، وحسابُه يفتح باب خصمٍ سالب)،
    // بينما `unitCost` أعلاه يبقى لقطة WAVG الحقيقية — هي أساس مصروف الهدية في قيد GIFT_OUT.
    const isGift = l.isGift === true;
    if (!isGift) {
      computeLineTotal({
        unitPrice,
        quantity: money(l.quantity),
        discountAmount: l.discountAmount,
        discountPercent: l.discountPercent,
      });
      if (l.promotionDiscount != null && l.promotionDiscount !== "") {
        computeLineTotal({
          unitPrice,
          quantity: money(l.quantity),
          discountAmount: l.promotionDiscount,
        });
      }
      if (l.cashierDiscountAmount != null && l.cashierDiscountAmount !== "") {
        computeLineTotal({
          unitPrice,
          quantity: money(l.quantity),
          discountAmount: l.cashierDiscountAmount,
        });
      }
    }
    const lineGross = unitPrice.mul(money(l.quantity));
    const lockedProduct = lockedProductById.get(v.productId);
    prePricedLines.push({
      l,
      v,
      productId: v.productId,
      categoryId:
        lockedProduct?.categoryId == null
          ? null
          : Number(lockedProduct.categoryId),
      isBaseUnit: isBaseUnitByUnitId.get(l.productUnitId) ?? true,
      baseQuantity,
      contractPrice,
      refUnit,
      unitPrice,
      kind,
      serviceCost,
      unitCost,
      lineCost,
      isGift,
      lineGross,
    });
  }

  // تقييم سلطوي على مستوى السلة لجميع أنواع العروض الـ 7 (PERCENT, AMOUNT, FIXED_PRICE, BUNDLE_PRICE, BOGO, TIERED_QTY, FREE_SHIPPING)
  const authoritativePromoByIdx = new Map<
    number,
    {
      promotionId: number;
      promotionName: string;
      discountAmount: Decimal;
      refDiscountAmount: Decimal;
      allowBelowCost: boolean;
    }
  >();
  let authoritativeFreeShippingPromo: {
    promotionId: number;
    promotionName: string;
    source: "AUTO" | "COUPON";
  } | null = null;
  const hasUpwardPriceOverride = prePricedLines.some(
    (pl) => !pl.isGift && pl.refUnit.gt(0) && pl.unitPrice.gt(pl.refUnit),
  );

  if (hasAnyPromoOrCoupon && prePricedLines.length > 0) {
    const evalChannel: "POS" | "STORE" =
      input.sourceType === "ONLINE" ? "STORE" : "POS";
    const evalCtx = {
      branchId: input.branchId,
      customerTier: tier,
      channel: evalChannel,
      todayYmd,
    };

    const baseEvalItems: CartEvalItem[] = prePricedLines.map((pl, idx) => ({
      lineKey: String(idx),
      productId: pl.productId,
      variantId: pl.l.variantId,
      productUnitId: pl.l.productUnitId,
      categoryId: pl.categoryId,
      unitPrice: pl.unitPrice.toFixed(2),
      quantity: money(pl.l.quantity).toNumber(),
      isBaseUnit: pl.isBaseUnit,
      hasContractPrice: pl.contractPrice != null,
      isBundle: pl.kind === "BUNDLE",
      isGift: pl.isGift,
      isService: pl.kind === "SERVICE",
    }));
    const refBaseEvalItems: CartEvalItem[] | null = hasUpwardPriceOverride
      ? prePricedLines.map((pl, idx) => ({
          ...baseEvalItems[idx]!,
          unitPrice: (pl.refUnit.gt(0)
            ? Decimal.min(pl.unitPrice, pl.refUnit)
            : pl.unitPrice
          ).toFixed(2),
        }))
      : null;

    if (lockedCoupon) {
      const couponSnapshot = await loadPromotionRuleSnapshot(tx, {
        branchId: input.branchId,
        customerTier: tier,
        todayYmd,
        includeStoreManaged: evalChannel === "STORE",
        evaluationChannel: evalChannel,
        requiredApplicationMode: "COUPON",
        specificPromotionId: lockedCoupon.promotionId,
      });
      const couponRules = snapshotToEngineRules(couponSnapshot);
      if (couponRules.length > 0) {
        const anyLineClaimedCoupon = prePricedLines.some(
          (pl) => Number(pl.l.promotionId) === lockedCoupon.promotionId,
        );
        const buildCouponEvalItems = (items: CartEvalItem[]) =>
          items.map((item, idx) => {
            const claimedPid =
              prePricedLines[idx]!.l.promotionId != null
                ? Number(prePricedLines[idx]!.l.promotionId)
                : null;
            const claimedOtherPromo =
              claimedPid != null &&
              claimedPid > 0 &&
              claimedPid !== lockedCoupon.promotionId;
            return {
              ...item,
              hasContractPrice: item.hasContractPrice || claimedOtherPromo,
            };
          });
        const couponEval = evaluateCartPromotions(
          buildCouponEvalItems(baseEvalItems),
          couponRules,
          evalCtx,
        );
        const refCouponEval = refBaseEvalItems
          ? evaluateCartPromotions(
              buildCouponEvalItems(refBaseEvalItems),
              couponRules,
              evalCtx,
            )
          : couponEval;
        const couponMeta = promoMetaById.get(lockedCoupon.promotionId);
        const couponPromoName = couponMeta?.name ?? lockedCoupon.code;
        for (const alloc of Array.from(couponEval.lineAllocations.values())) {
          const lineIdx = Number(alloc.lineKey);
          if (
            anyLineClaimedCoupon &&
            Number(prePricedLines[lineIdx]?.l.promotionId) !==
              lockedCoupon.promotionId
          ) {
            continue;
          }
          const disc = money(alloc.discountAmount.toFixed(2));
          if (disc.gt(0)) {
            const refAlloc = refCouponEval.lineAllocations.get(alloc.lineKey);
            const refDisc = refAlloc
              ? Decimal.min(disc, money(refAlloc.discountAmount.toFixed(2)))
              : money(0);
            authoritativePromoByIdx.set(lineIdx, {
              promotionId: lockedCoupon.promotionId,
              promotionName: couponPromoName,
              discountAmount: disc,
              refDiscountAmount: refDisc,
              allowBelowCost: couponMeta?.allowBelowCost === true,
            });
          }
        }
        if (couponEval.freeShippingPromotion) {
          authoritativeFreeShippingPromo = {
            promotionId: couponEval.freeShippingPromotion.promotionId,
            promotionName:
              couponEval.freeShippingPromotion.promotionName || couponPromoName,
            source: "COUPON",
          };
        }
      }
    }

    const claimedAutoPromoIds = Array.from(
      new Set(
        prePricedLines
          .map((pl) =>
            pl.l.promotionId != null ? Number(pl.l.promotionId) : null,
          )
          .filter(
            (pid): pid is number =>
              pid != null &&
              pid > 0 &&
              (!lockedCoupon || pid !== lockedCoupon.promotionId),
          ),
      ),
    );

    const shouldEvaluateAutoShipping =
      hasShippingContext &&
      input.sourceType !== "ONLINE" &&
      !authoritativeFreeShippingPromo;

    if (claimedAutoPromoIds.length > 0 || shouldEvaluateAutoShipping) {
      const autoSnapshot = await loadPromotionRuleSnapshot(tx, {
        branchId: input.branchId,
        customerTier: tier,
        todayYmd,
        includeStoreManaged: evalChannel === "STORE",
        evaluationChannel: evalChannel,
        requiredApplicationMode: "AUTO",
      });
      const allAutoRules = snapshotToEngineRules(autoSnapshot);
      if (claimedAutoPromoIds.length > 0) {
        const buildAutoEvalItems = (items: CartEvalItem[]) =>
          items.map((item, idx) => {
            const pl = prePricedLines[idx]!;
            const claimedPid =
              pl.l.promotionId != null ? Number(pl.l.promotionId) : null;
            const isCouponClaim =
              lockedCoupon != null && claimedPid === lockedCoupon.promotionId;
            const hasUnclaimedPriceOverride =
              (claimedPid == null || claimedPid <= 0) &&
              pl.refUnit.gt(0) &&
              !pl.unitPrice.eq(pl.refUnit) &&
              !pl.unitPrice.eq(
                pl.refUnit.toDecimalPlaces(0, Decimal.ROUND_HALF_UP),
              );
            const hasUnclaimedInvoiceManualDiscount =
              (claimedPid == null || claimedPid <= 0) &&
              money(pl.l.cashierDiscountAmount ?? "0").lte(0) &&
              (money(pl.l.discountAmount ?? "0").gt(0) ||
                money(pl.l.discountPercent ?? "0").gt(0));
            return {
              ...item,
              hasContractPrice:
                item.hasContractPrice ||
                authoritativePromoByIdx.has(idx) ||
                isCouponClaim ||
                hasUnclaimedPriceOverride ||
                hasUnclaimedInvoiceManualDiscount,
            };
          });
        const autoEval = evaluateCartPromotions(
          buildAutoEvalItems(baseEvalItems),
          allAutoRules,
          evalCtx,
        );
        const refAutoEval = refBaseEvalItems
          ? evaluateCartPromotions(
              buildAutoEvalItems(refBaseEvalItems),
              allAutoRules,
              evalCtx,
            )
          : autoEval;
        for (const alloc of Array.from(autoEval.lineAllocations.values())) {
          const lineIdx = Number(alloc.lineKey);
          const claimedPid = Number(prePricedLines[lineIdx]?.l.promotionId);
          if (claimedPid !== alloc.promotionId) continue;
          const meta = promoMetaById.get(alloc.promotionId);
          if (!meta || !meta.isActive) continue;
          const disc = money(alloc.discountAmount.toFixed(2));
          if (disc.gt(0) && !authoritativePromoByIdx.has(lineIdx)) {
            const refAlloc = refAutoEval.lineAllocations.get(alloc.lineKey);
            const refDisc =
              refAlloc && refAlloc.promotionId === alloc.promotionId
                ? Decimal.min(disc, money(refAlloc.discountAmount.toFixed(2)))
                : money(0);
            authoritativePromoByIdx.set(lineIdx, {
              promotionId: alloc.promotionId,
              promotionName: meta.name,
              discountAmount: disc,
              refDiscountAmount: refDisc,
              allowBelowCost: meta.allowBelowCost === true,
            });
          }
        }
      }
      if (shouldEvaluateAutoShipping) {
        const shippingAutoEval = evaluateCartPromotions(
          baseEvalItems,
          allAutoRules,
          evalCtx,
        );
        if (shippingAutoEval.freeShippingPromotion) {
          authoritativeFreeShippingPromo = {
            promotionId: shippingAutoEval.freeShippingPromotion.promotionId,
            promotionName: shippingAutoEval.freeShippingPromotion.promotionName,
            source: "AUTO",
          };
        }
      }
    }
  }

  const computed = [];
  for (let idx = 0; idx < prePricedLines.length; idx++) {
    const {
      l,
      v,
      baseQuantity,
      refUnit,
      unitPrice,
      kind,
      serviceCost,
      unitCost,
      lineCost,
      isGift,
      lineGross,
    } = prePricedLines[idx]!;

    // M4 (F19/F20): 1. حلّ العرض الترويجي الإداري والتحقق منه سلطوياً وسقفه بقيمة المحرك
    let recordedPromotionId: number | null = null;
    let recordedPromoDiscount = money(0);
    let recordedRefPromoDiscount = money(0);
    let promoAllowBelowCost = false;

    const authPromo = !isGift ? authoritativePromoByIdx.get(idx) : undefined;
    if (authPromo && authPromo.discountAmount.gt(0)) {
      recordedPromotionId = authPromo.promotionId;
      promoAllowBelowCost = authPromo.allowBelowCost;
      if (l.promotionDiscount != null && l.promotionDiscount !== "") {
        recordedPromoDiscount = Decimal.max(
          money(0),
          Decimal.min(money(l.promotionDiscount), authPromo.discountAmount),
        );
      } else if (l.discountAmount != null && l.discountAmount !== "") {
        recordedPromoDiscount = Decimal.max(
          money(0),
          Decimal.min(money(l.discountAmount), authPromo.discountAmount),
        );
      } else {
        recordedPromoDiscount = authPromo.discountAmount;
      }
      recordedRefPromoDiscount = Decimal.min(
        recordedPromoDiscount,
        authPromo.refDiscountAmount,
      );
    }

    // M4 (F19): 2. احتساب صافي السعر بعد العرض وتحديد خصم الكاشير اليدوي
    const lineTotalAfterPromo = lineGross.minus(recordedPromoDiscount);

    let cashierManualDiscount = money(0);
    if (l.cashierDiscountAmount != null && l.cashierDiscountAmount !== "") {
      cashierManualDiscount = money(l.cashierDiscountAmount);
    } else if (l.discountAmount != null && l.discountAmount !== "") {
      const rawDiscount = money(l.discountAmount);
      cashierManualDiscount = rawDiscount.gt(recordedPromoDiscount)
        ? rawDiscount.minus(recordedPromoDiscount)
        : money(0);
    } else if (l.discountPercent != null && l.discountPercent !== "") {
      const pct = money(l.discountPercent);
      if (pct.gt(0)) {
        cashierManualDiscount = lineTotalAfterPromo.gt(0)
          ? lineTotalAfterPromo.mul(pct).div(100)
          : money(0);
      }
    }

    // M4: 3. إجمالي خصم السطر وصافي السطر
    const totalLineDiscount = clampMoney(
      round2(recordedPromoDiscount.plus(cashierManualDiscount)),
      round2(lineGross),
    );

    const lineRes = isGift
      ? computeLineTotal({ unitPrice: money(0), quantity: money(l.quantity) })
      : {
          unitPrice: unitPrice.toDecimalPlaces(2).toFixed(2),
          quantity: money(l.quantity).toDecimalPlaces(3).toFixed(3),
          discountAmount: totalLineDiscount.toFixed(2),
          total: round2(lineGross.minus(totalLineDiscount)).toFixed(2),
        };

    computed.push({
      variantId: l.variantId,
      productUnitId: l.productUnitId,
      baseQuantity,
      unitPrice: lineRes.unitPrice,
      refUnit,
      hasManualPriceReduction: !isGift && unitPrice.lt(refUnit),
      unitCost,
      lineCost,
      serviceMaterials: serviceCost?.materials ?? [],
      quantity: lineRes.quantity,
      discountAmount: lineRes.discountAmount,
      total: lineRes.total,
      kind,
      isGift,
      promotionId: recordedPromotionId,
      promotionDiscount: recordedPromoDiscount.toFixed(2),
      refPromotionDiscount: recordedRefPromoDiscount.toFixed(2),
      allowBelowCost: promoAllowBelowCost,
      cashierDiscountAmount: cashierManualDiscount.toFixed(2),
      promotionName: !isGift && recordedPromotionId ? (authPromo?.promotionName ?? null) : null,
      internalLineToken: l.internalLineToken?.trim() || null,
      invoiceName: titleForChannel(
        {
          name: v.productName,
          invoiceLabel: v.invoiceLabel,
          shortTitle: v.shortTitle,
        },
        "invoice",
      ),
    });
  }

  const feeHeldPrecheckD = round2(money(input.deliveryFeeHeld ?? "0"));
  const rawInputDeliveryFeeD = round2(money(input.deliveryFee ?? "0"));
  const resolvedCourierFeeD = input.delivery
    ? round2(money(resolvedDeliveryFee ?? "0"))
    : money(0);
  let effectiveDeliveryFeeStr = input.deliveryFee;
  let effectiveDeliveryFreeInput = input.deliveryFree === true;
  let effectiveDeliveryWaivedStr = input.deliveryWaivedAmount ?? "0";
  let effectiveCourierFeeCollection = input.delivery?.feeCollection ?? "COURIER";

  if (authoritativeFreeShippingPromo) {
    if (input.delivery && feeHeldPrecheckD.lte(0)) {
      effectiveCourierFeeCollection = "SHOP";
      if (resolvedCourierFeeD.gt(0) && rawInputDeliveryFeeD.lte(0)) {
        effectiveDeliveryFreeInput = true;
        if (round2(money(effectiveDeliveryWaivedStr)).lte(0)) {
          effectiveDeliveryWaivedStr = resolvedCourierFeeD.toFixed(2);
        }
      }
    } else if (!input.delivery && input.deliveryFree !== true && rawInputDeliveryFeeD.gt(0)) {
      effectiveDeliveryFeeStr = "0";
      effectiveDeliveryFreeInput = true;
      effectiveDeliveryWaivedStr = rawInputDeliveryFeeD.toFixed(2);
    }
  }

  const deliveryFeeD = round2(money(effectiveDeliveryFeeStr ?? "0"));
  const isFreeDelivery = effectiveDeliveryFreeInput && deliveryFeeD.lte(0);
  const waivedDelivery = round2(money(effectiveDeliveryWaivedStr));
  const couponShippingWaivedD =
    authoritativeFreeShippingPromo?.source === "COUPON" && isFreeDelivery
      ? waivedDelivery
      : money(0);

  const couponLines = lockedCoupon
    ? computed.filter((line) => line.promotionId === lockedCoupon.promotionId)
    : [];

  const totalCouponDiscount = couponLines.reduce(
    (sum, line) => sum.plus(money(line.promotionDiscount)),
    money(0),
  );

  if (lockedCoupon && totalCouponDiscount.lte(0) && couponShippingWaivedD.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الكوبون صالح لكنه لا ينطبق على أصناف الفاتورة" });
  }

  let couponDiscount = totalCouponDiscount;
  if (lockedCoupon && totalCouponDiscount.gt(0)) {
    const allocation = allocateCouponDiscountAcrossLines(
      computed,
      lockedCoupon.promotionId,
      lockedCoupon.maxDiscountAmount,
    );
    couponDiscount = money(allocation.totalCouponDiscount);
    const refAllocation = hasUpwardPriceOverride
      ? allocateCouponDiscountAcrossLines(
          computed.map((c) => ({
            ...c,
            promotionDiscount: c.refPromotionDiscount,
          })),
          lockedCoupon.promotionId,
          lockedCoupon.maxDiscountAmount,
        )
      : allocation;
    for (let i = 0; i < computed.length; i++) {
      computed[i].promotionDiscount = allocation.lines[i].promotionDiscount;
      computed[i].discountAmount = allocation.lines[i].discountAmount;
      computed[i].total = allocation.lines[i].total;
      computed[i].refPromotionDiscount = Decimal.min(
        money(allocation.lines[i].promotionDiscount),
        money(refAllocation.lines[i].promotionDiscount),
      ).toFixed(2);
    }
  }

  // M4 (F19): 4. فحص بوابة H6 للخصم اليدوي بعد استقرار مبالغ العروض والكوبونات النهائية
  // يُحسَب الإعفاء الترويجي مقابل السعر المرجعي (refPromotionDiscount) لا السعر اليدوي المُضخَّم،
  // فلا يستطيع رفع unitPriceOverride محوَ خطّ الأساس المرجعي وتمرير خصم يدوي فوق العتبة بلا موافقة مدير.
  let manualDiscountGateTriggered = false;
  let referenceGrossAfterPromos = money(0);
  for (const line of computed) {
    if (line.isGift) continue;
    const lineRefGross = line.refUnit.times(money(line.quantity));
    const lineRefPromoDisc = Decimal.min(
      money(line.promotionDiscount),
      money(line.refPromotionDiscount),
    );
    const lineRefAfterPromo = Decimal.max(
      money(0),
      lineRefGross.minus(lineRefPromoDisc),
    );
    if (
      lineDiscountExceedsThreshold(lineRefAfterPromo, money(1), line.total)
    ) {
      manualDiscountGateTriggered = true;
    }
    referenceGrossAfterPromos = referenceGrossAfterPromos.plus(lineRefAfterPromo);
  }

  // 5. Deterministic lock order: sort by variantId ascending.
  computed.sort((a, b) => a.variantId - b.variantId);

  // 6. Totals + COGS.
  const totals = computeInvoiceTotals({
    lineTotals: computed.map((c) => c.total),
    invoiceDiscount: input.invoiceDiscount,
    taxRatePercent: input.taxRatePercent,
    deliveryFee: effectiveDeliveryFeeStr,
  });

  const basketSubtotal = round2(
    computed.reduce(
      (sum, line) => sum.plus(money(line.unitPrice).times(line.quantity)),
      money(0),
    ),
  );
  if (lockedCoupon?.minOrderSpend && money(lockedCoupon.minOrderSpend).gt(0)) {
    const minSpend = money(lockedCoupon.minOrderSpend);
    if (basketSubtotal.lt(minSpend)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لم يبلغ إجمالي الطلب الحد الأدنى لتفعيل الكوبون",
          why: `الحد الأدنى المطلوب لتفعيل هذا الكوبون هو ${minSpend.toFixed(2)} د.ع بينما إجمالي سلتك الحالي ${basketSubtotal.toFixed(2)} د.ع`,
          doThis: "أضف المزيد من المنتجات إلى سلة الشراء لتفعيل الكوبون",
        }),
      });
    }
  }
  // هدايا الفاتورة (0149): فصلُ وعاءين. `costTotal` (⇐ `invoices.costTotal` وقيد SALE) يبقى
  // **تكلفة البنود المدفوعة وحدها** — فالثابت القائم «SALE.cost = invoices.costTotal» يظلّ سارياً
  // ويظلّ كلُّ قارئٍ قائمٍ صحيحاً بلا مساس (COALESCE(ic.cost, i.costTotal) في تقارير المبيعات،
  // عكس التكلفة الكامل في مرتجع التوصيل، تحليل ربحية أوامر الشغل). وتكلفة الهدايا تُرحَّل وحدها
  // في قيد GIFT_OUT (§١١.ب) مصروفَ هدايا وترويج — الاعتراف بها مرّةً واحدةً لا مرّتين.
  const paidLines = computed.filter((c) => !c.isGift);
  const giftLines = computed.filter((c) => c.isGift);
  const costTotal = computeInvoiceCost(paidLines);
  const giftCost = computeInvoiceCost(giftLines);

  // إفصاح التوصيل المجّاني (0152): «مجّانيّ» = أجرةٌ صفر حتماً. الحسم خادميّ لا من الشاشة:
  // عَلَمٌ مع أجرةٍ موجبة تناقضٌ (فاتورةٌ تقول «مجاناً» وتقبض) ⇒ الأجرة تُغلِّب والعَلَم يسقط.
  // القيمة المُتنازَل عنها إفصاحيّة بحتة: تُعرَض للزبون وتُحصى في التقارير ولا تدخل إيراداً
  // ولا قيداً — الإيراد يبقى `deliveryFee` وحده (صفرٌ في هذه الحالة).
  if (waivedDelivery.lt(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "قيمة التوصيل المُتنازَل عنها لا تصحّ أن تكون سالبة",
    });
  }
  // قرار المالك (٦/٨/٢٦): **القيمة إلزامية عند تفعيل «مجاني»**. كانت اختيارية فتُخزَّن صفراً،
  // فتضيع فائدة القياس («كم أهديتُ توصيلاً وبكم؟») على تلك الفواتير وتُطبَع «مجاناً» بلا مقدار.
  // الإلزام هنا لا في الشاشة وحدها: الشاشة تُرشِد، والخادم يمنع — فلا تتسرّب فاتورةٌ ناقصة
  // الإفصاح من أيّ قناة (استيراد/أوفلاين/تكامل مستقبليّ).
  if (isFreeDelivery && waivedDelivery.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "أدخِل قيمة أجرة التوصيل قبل جعله مجّانياً — تُطبَع للزبون وتُحصى في التقارير",
    });
  }

  // 6.b SALES-01/02 — بوّابة البيع بأقل من التكلفة مع إعفاء العروض المصرحة (allowBelowCost = true) (F20)
  // الإعفاء يقتصر حصراً على الخسارة الناتجة عن العرض الرسمي ذاته دون أي خصم يدوي إضافي على السطر أو الرأس.
  let unapprovedBelowCost = false;
  let effectiveCostFloor = money(0);

  for (const l of paidLines) {
    const lCost =
      l.lineCost != null
        ? money(l.lineCost)
        : money(l.unitCost).times(l.baseQuantity);
    const lTotal = money(l.total);
    const isExemptPromoLoss =
      l.allowBelowCost &&
      money(l.cashierDiscountAmount).lte(0) &&
      !l.hasManualPriceReduction;
    if (lTotal.lt(lCost) && !isExemptPromoLoss) {
      unapprovedBelowCost = true;
    }
    effectiveCostFloor = effectiveCostFloor.plus(
      isExemptPromoLoss ? Decimal.min(lCost, lTotal) : lCost,
    );
  }

  const invoiceRevenue = money(totals.subtotal).minus(
    money(totals.discountAmount),
  );
  if (invoiceRevenue.lt(round2(effectiveCostFloor))) {
    unapprovedBelowCost = true;
  }

  const belowCost = unapprovedBelowCost;
  // حارس شذوذ التكلفة الكارثي (كشف إدخال تكلفة الوجبة ككلفة للقطعة):
  // إذا كان السطر غير مهدى، وتجاوزت التكلفة المحتسبة للسطر إيراده بأكثر من ٥ أضعاف
  // وكان فارق الخسارة على السطر يتجاوز ٥٠٠,٠٠٠ د.ع ⇒ رفض قاطع لحماية الدفتر المالي من الأخطاء الكارثية.
  for (const l of paidLines) {
    const lineCost = money(l.unitCost).times(l.baseQuantity);
    const lineTotal = money(l.total);
    if (
      lineCost.gt(lineTotal.times(5)) &&
      lineCost.minus(lineTotal).gt(500_000)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر إتمام البيع بسبب شذوذ في تكلفة البند «${l.invoiceName ?? l.variantId}»`,
          why: `التكلفة المحتسبة للسطر (${lineCost.toFixed(2)} د.ع) تفوق سعر البيع (${lineTotal.toFixed(2)} د.ع) بأكثر من ٥ أضعاف وبفارق خسارة يتجاوز ٥٠٠ ألف دينار`,
          doThis:
            "تحقّق من كلفة الوحدة في بطاقة الصنف أو قسّم تكلفة الوجبة على عدد القطع قبل حفظ الفاتورة لمنع تشويه الدفتر المالي",
        }),
      });
    }
  }
  // H6/H7: بوّابة الخصم اليدويّ فوق التكلفة — تُفرَض على قناة POS الحيّة فقط، لا على إعادة تشغيل
  // الأوفلاين (offlineCapture): بيعٌ اكتمل والتقاطُه لا يُعاد حظره — يُوسَم للمراجعة لا غير. المرتفعون
  // والقنوات المُقِرّة سلفاً (بث/عرض سعر) يمرّون عبر priceOverrideApproved كما في بوّابة تحت-التكلفة.
  // خصمُ الرأس يُقاس على الصافي (المجموع − خصم الفاتورة) مقابل المرجع الإجماليّ بعد استبعاد خصم العروض الرسمية.
  const invoiceNet = money(totals.subtotal).minus(money(totals.discountAmount));
  const headDiscountGate = invoiceDiscountExceedsThreshold(
    referenceGrossAfterPromos,
    invoiceNet,
  );
  if (headDiscountGate) manualDiscountGateTriggered = true;
  const manualGate = manualDiscountGateTriggered && !input.offlineCapture;
  // بعد إصدار كرت خارجي لا يجوز أن يحوّل تغيّر WAVG/مرجع السعر بين prepare وfinalize
  // العملية إلى كرتٍ صادر بلا فاتورة. DIGITAL_SALE_CAPABILITY تعني أن الشروط التجارية
  // اجتازت بوابة النيّة قبل الفعل الخارجي؛ وهي Symbol داخلية لا يستطيع راوتر/عميل تصنيعها.
  const digitalIntentPreflight = capability === DIGITAL_SALE_CAPABILITY;
  if (
    (belowCost || manualGate) &&
    !input.priceOverrideApproved &&
    !digitalIntentPreflight
  ) {
    const reason = belowCost
      ? "بيع بأقل من التكلفة"
      : headDiscountGate
        ? `خصم الفاتورة يتجاوز ${Math.round(MANUAL_DISCOUNT_APPROVAL_THRESHOLD * 100)}٪ عن مرجعها`
        : `خصمٌ يتجاوز ${Math.round(MANUAL_DISCOUNT_APPROVAL_THRESHOLD * 100)}٪ عن السعر المرجعيّ`;
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${reason} يتطلب موافقة مدير.`,
    });
  }

  // 6.ج حوكمة الهدايا داخل الفاتورة: تُستعار عتبةُ سند الهدية المستقلّ نفسها
  //     (`GIFT_APPROVAL_THRESHOLD`) فلا تصير الفاتورة باباً خلفياً يلتفّ على حوكمة وحدة الهدايا
  //     (إهداءٌ بلا سقف من شاشة البيع). المعيار **تكلفةُ** الهدية لا سعرُها (السعر صفر دائماً).
  //     تحت العتبة يمرّ الكاشير مباشرةً؛ فوقها يفتح حوارُ اعتماد المدير نفسه (priceOverrideApproved).
  const giftCostD = money(giftCost);
  if (
    giftCostD.gt(money(GIFT_APPROVAL_THRESHOLD)) &&
    !input.priceOverrideApproved &&
    !digitalIntentPreflight
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `تكلفة الهدايا في هذه الفاتورة (${giftCostD.toFixed(2)}) تتجاوز حدّ الإهداء بلا تفويض (${money(GIFT_APPROVAL_THRESHOLD).toFixed(2)} د.ع) — يتطلب موافقة مدير.`,
    });
  }

  // 7. تقريب نقدي IQD للبيع النقدي الكامل فقط (عندما تكون جميع أرجل الدفع نقدية):
  //    في الدفعات المختلطة (نقد + بطاقة) يبقى الإجمالي الدقيق دون تقريب لئلا ينجرف الخادم عن العميل.
  const hasCashLeg = rawPaymentLegs.some((leg) => leg.method === "CASH");
  const allCashLegs =
    (rawPaymentLegs.length > 0 || input.preCollected?.method === "CASH") &&
    (!input.preCollected?.method || input.preCollected.method === "CASH") &&
    rawPaymentLegs.every((leg) => leg.method === "CASH");
  const roundCash = !!input.cashRoundIQD && allCashLegs;
  const grandTotalD = money(totals.total);
  // ش٦ — تقريب السلّة المختلطة: هذه الفاتورة تحمل فرق تقريب السلّة كلّها (checkoutReception
  // يضبطه حصراً). مراجعة PR #495: الفرق **يُشتقّ خادمياً** من إجماليّ الأسطر المحسوب هنا
  // ومجموعِ بقيّة السلّة كما حسبه الخادم — لا مبلغَ من العميل (كان يُقبل أيّ رقمٍ ضمن ٢٤٩
  // ديناراً = خصمٌ غير معتمد يتخطّى بوّابتَي «تحت التكلفة» و«الخصم اليدويّ»).
  let overrideD: ReturnType<typeof money> | null = null;
  if (
    input.cashRoundingBasketOthers != null &&
    allCashLegs
  ) {
    const basketRawD = round2(
      grandTotalD.plus(money(input.cashRoundingBasketOthers)),
    );
    const deltaD = roundCashIQD(basketRawD).minus(basketRawD); // |الفرق| ≤ ١٢٥ حتماً
    const cand = round2(grandTotalD.plus(deltaD));
    if (cand.gt(0)) overrideD = cand;
  }
  const effectiveTotalD =
    overrideD ?? (roundCash ? roundCashIQD(grandTotalD) : grandTotalD);
  const cashRoundingAdj = effectiveTotalD.minus(grandTotalD); // ± (صفر إن لا تقريب)
  const tendered = rawPaymentLegs.reduce(
    (sum, leg) => sum.plus(round2(money(leg.amount))),
    money(0),
  );
  const nonCashTenderedD = rawPaymentLegs.reduce(
    (sum, leg) =>
      leg.method === "CASH" ? sum : sum.plus(round2(money(leg.amount))),
    money(0),
  );
  // ش٤ (§٧.٢): المقبوض سلفاً (عرابين المسوّدة) يدخل الحساب **قبل** حرّاس الآجل/الائتمان —
  // هذا هو الترتيب الحاسم: لولاه لرُفض زبونٌ عابر سدّد عربوناً كاملاً بحجّة «البيع الآجل
  // يتطلب عميلاً» بينما ماله محبوسٌ في receipts (الحاصرة ١.١).
  const preCollectedD = round2(money(input.preCollected?.amount ?? "0"));
  // تصحيح الفاتورة (0168): allowPreCollectedOverpay يرفع هذا الحارس فقط (يضبطه correctSale داخلياً)
  // — overpay-down يقصُر paidNow على الإجمالي (سطر أدناه) والفائض يُردّ/يُرصَّد خارجياً بعد الترحيل.
  if (!input.allowPreCollectedOverpay && preCollectedD.gt(effectiveTotalD)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `المقبوض سلفاً (${preCollectedD.toFixed(2)}) يتجاوز مستحق الفاتورة (${effectiveTotalD.toFixed(2)}) — خلل توزيع، راجع الطلب المحفوظ.`,
    });
  }
  // SALES-05 (تدقيق ٢/٧): كان paidNow يُفرَض = الإجمالي المقرّب عند roundCash متجاهلاً المبلغ
  // المُسلَّم ⇒ بيع آجل جزئي بعلم cashRoundIQD=true يُسجَّل «مدفوعاً بالكامل» فتُمحى ذمة العميل
  // (والنقد الوهمي يظهر عجزاً بدرج الكاشير). الآن: التقريب يطبَّق على الإجمالي دائماً، لكن نعامل
  // البيع كمدفوعٍ بالكامل (paidNow = الإجمالي المقرّب) فقط إذا كان المُسلَّم يغطّي الإجمالي فعلاً؛
  // وإلا فهي دفعة جزئية ⇒ paidNow = المُسلَّم بالضبط والباقي ذمّة على العميل.
  // في الدفعات المقسّمة: مجموع الدفعات غير النقدية (أو الإجمالي عند غياب النقد) لا يجوز أن يتجاوز الفاتورة.
  if (
    !input.allowPreCollectedOverpay &&
    ((!hasCashLeg && preCollectedD.plus(tendered).gt(effectiveTotalD)) ||
      (hasCashLeg && preCollectedD.plus(nonCashTenderedD).gt(effectiveTotalD)))
  ) {
    const offendingAmount = hasCashLeg
      ? preCollectedD.plus(nonCashTenderedD)
      : preCollectedD.plus(tendered);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `المبلغ المدفوع (${offendingAmount.toFixed(2)}) يتجاوز مستحق الفاتورة (${effectiveTotalD.toFixed(2)}).`,
    });
  }
  // الزيادة النقدية هي باقي للعميل، لا paidAmount ولا receipt ولا نقداً باقياً في الدرج.
  // paidNow = إجمالي المسدَّد على الفاتورة (سلفاً + الآن)؛ الإيصال الجديد للجزء الجديد وحده.
  const totalTenderedD = preCollectedD.plus(tendered);
  const paidNow = totalTenderedD.gt(effectiveTotalD)
    ? effectiveTotalD
    : totalTenderedD;
  const newMoneyD = round2(paidNow.minus(preCollectedD));
  const unpaid = effectiveTotalD.minus(paidNow);
  // ش٧ (قرار المالك ٦/٨): متبقّي فاتورة التوصيل COD ليس بيعاً آجلاً على زبونٍ عابر — إنّه
  // **عهدةٌ على المندوب** تُرفع في نفس المعاملة (dispatchInvoiceInTx). الاستثناء محصورٌ
  // بالعلم الداخليّ الذي ترفعه الخدمةُ المُسنِدة وحدها؛ حدّ ائتمان العميل المسجَّل يبقى نافذاً.
  if (unpaid.gt(0) && !input.customerId && !input.codDispatchPending) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "البيع الآجل يتطلب عميلاً محدداً",
    });
  }
  // 7.b فحص حدّ الائتمان (H4): null=بلا حدّ، 0=حظر آجل، >0=فحص الإسقاط.
  //     B5 (١٩/٦/٢٦): الموافقة لم تعد blanket — تحتاج إمّا (أ) creditApprovalId جاهز، أو (ب) managerOverrideByUserId
  //     يكون الـrouter قد وثّق هويته. الخدمة في حالة (ب) تُنشئ approval ذرّياً داخل نفس withTx.
  let effectiveApprovalId = input.creditApprovalId;
  // وضع الافتتاح — إعفاء حاجز الائتمان (قرار المالك ١٠/٨): أثناء النافذة الفعّالة تُعفى قنوات
  // الاستقبال/التنفيذ من فحص السقف/الموافقة. الدَّين يُرحَّل ذمّةً كاملة على العميل (AR) لكنه لا
  // يُرفض — يُرخَّى الحاجز لا التسجيل. مؤقّتٌ وينتهي بانتهاء النافذة (البيع الآجل يظلّ يتطلّب عميلاً).
  const receptionDeferredWaiver =
    unpaid.gt(0) &&
    !!input.customerId &&
    input.receptionDeferredAuthorized === true;
  const openingCreditWaiver =
    unpaid.gt(0) &&
    !!input.customerId &&
    !input.allowNegativeStock &&
    input.codDispatchPending !== true && // COD يبقى محكوماً بحدّ ائتمان العميل المسجَّل (main).
    OPENING_RECEPTION_CHANNELS.has(input.sourceType ?? "POS") &&
    (await readOpeningWindowState(tx)).active;
  const preflight = input.digitalCreditPreflight;
  const digitalCreditPreflight =
    unpaid.gt(0) &&
    capability === DIGITAL_SALE_CAPABILITY &&
    preflight?.capability === VERIFIED_DIGITAL_CREDIT_PREFLIGHT &&
    input.customerId === preflight.customerId &&
    input.branchId === preflight.branchId &&
    input.sourceType === "POS" &&
    input.clientRequestId === `DIGITAL_INTENT:${preflight.intentId}` &&
    unpaid.eq(money(preflight.amount));
  if (preflight != null && !digitalCreditPreflight) {
    throw new TRPCError({ code: "FORBIDDEN", message: appErrorMessage({
      what: "تعذّر تثبيت ذمة البيع الرقمي",
      why: "تفويض ائتمان النيّة الرقمية لا يطابق العميل والفرع والمبلغ",
      doThis: "راجع النيّة من طابور الكروت مع مسؤول النظام",
    }) });
  }
  if (receptionDeferredWaiver) {
    logger.info(
      {
        customerId: input.customerId,
        unpaid: unpaid.toFixed(2),
        sourceType: input.sourceType,
      },
      "sale: بيع استقبال بدون عربون — تفويض هوية العميل محقق داخل checkoutReception",
    );
  } else if (openingCreditWaiver) {
    logger.info(
      {
        customerId: input.customerId,
        unpaid: unpaid.toFixed(2),
        sourceType: input.sourceType ?? "POS",
      },
      "sale: إعفاء حدّ الائتمان أثناء وضع الافتتاح — الذمّة تُرحَّل على العميل كاملةً",
    );
  } else if (unpaid.gt(0) && input.customerId) {
    if (input.creditApproved) {
      if (!input.creditApprovalId && !input.managerOverrideByUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "تجاوز السقف يحتاج موافقة مُسجَّلة (creditApprovalId) أو هوية مدير مُتحقَّق منها — لا تُقبل موافقة بلا سقف.",
        });
      }
      if (!effectiveApprovalId && input.managerOverrideByUserId) {
        // تَنشئ Approval تلقائياً، مرتبطة بهذا العميل + سقف=unpaid (تماماً)، single-use.
        const created = await (
          await import("../creditApprovalService")
        ).createApproval(tx, {
          customerId: input.customerId,
          branchId: input.branchId,
          maxAmount: unpaid.toFixed(2),
          approvedBy: input.managerOverrideByUserId,
          ttlMinutes: 5,
          notes: "manager-verified override via sale router (auto-generated)",
        });
        effectiveApprovalId = created.id;
      }
      // SELECT FOR UPDATE داخل validateApproval ⇒ لا double-spend عبر سباق.
      await validateApproval(
        tx,
        effectiveApprovalId!,
        input.customerId,
        unpaid,
        {
          branchId: input.branchId,
          consumerUserId: actor.userId,
        },
      );
    } else if (!digitalCreditPreflight) {
      // paymentMode='COD' (٢٨/٨/٢٦، هجرة 0276): يُتجاوز فحصُ السقف — المال يأتي مع المندوب،
      // لا يبقى ديناً على العميل. الحمايةُ بديلة عبر workOrder.deliver عند التسليم.
      await assertCreditLimit(
        tx,
        input.customerId,
        unpaid,
        input.branchId,
        input.paymentMode ?? undefined,
      );
    }
  }

  // 8. Invoice header with unified transaction tracking number
  let invoiceNumber: string;
  if (input.trackingNumber?.trim()) {
    const cleanTracking = stripDocPrefix(input.trackingNumber.trim());
    const isExplicitlySuffixed =
      /^\d+-\d+$/.test(cleanTracking) ||
      /^(?:INV|WO|ORD|CNS?|PO|QUO)-\d+-\d{8}-\d+-\d+$/i.test(cleanTracking);
    const baseTrackingNumber = isExplicitlySuffixed
      ? cleanTracking.replace(/-\d+$/, "")
      : cleanTracking;
    const hasExplicitSuffix =
      isExplicitlySuffixed || input.siblingIndex != null;
    const preferred =
      isExplicitlySuffixed && input.siblingIndex == null
        ? cleanTracking
        : formatDocumentNumber(
            baseTrackingNumber,
            input.siblingIndex ?? undefined,
          );
    const existingNums = await tx
      .select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(
        or(
          eq(invoices.invoiceNumber, baseTrackingNumber),
          like(invoices.invoiceNumber, `${baseTrackingNumber}-%`),
        ),
      )
      .for("update");
    const used = new Set(existingNums.map((r) => r.invoiceNumber));
    const needsSiblingSuffix =
      used.has(preferred) || (!hasExplicitSuffix && used.size > 0);
    if (!needsSiblingSuffix) {
      invoiceNumber = preferred;
    } else {
      let k = 1;
      while (used.has(formatDocumentNumber(baseTrackingNumber, k))) {
        k += 1;
      }
      invoiceNumber = formatDocumentNumber(baseTrackingNumber, k);
    }
  } else {
    const baseTrackingNumber = await nextTransactionTrackingNumber(tx);
    invoiceNumber = formatDocumentNumber(
      baseTrackingNumber,
      input.siblingIndex ?? undefined,
    );
  }
  let status = computeInvoiceStatus(
    toDbMoney(effectiveTotalD),
    toDbMoney(paidNow),
  );
  // وعاء الإسناد التجاري: صافي إيراد البضاعة بعد استبعاد الخصم وأجرة الشحن
  const baseRevenueForAttribution = round2(
    money(totals.subtotal).minus(money(totals.discountAmount)),
  );

  // حل خطة الإسناد التجاري متعدد الأدوار (Multi-Role Sales Attribution)
  const attributionPlan = resolveSaleAttribution({
    branchId: input.branchId,
    cashierUserId: actor.userId,
    attribution: input.attribution,
    salesRepId: input.attribution?.repId ?? input.salesRepId,
    assistedByUserId: input.attribution?.assistedById ?? input.assistedByUserId,
    attributionMode: input.attribution?.mode ?? input.attributionMode,
    attributeToUserId: input.attributeToUserId,
    baseAmount: baseRevenueForAttribution,
  });

  // لقطة اسم البائع: يُعرض على الإيصال اسم البائع التجاري الأساسي
  const salespersonNameSnapshot = await userNameSnapshot(tx, attributionPlan.primaryUserId);
  // نسبة البيع: الفاعل، إلّا أن يُمرَّر `attributeToUserId` صراحةً (تفويضٌ داخليّ — التصحيح
  // يُعيد إصدار بيع البائع الأصليّ بيد مديرٍ، فلا تُنقَل عمولته إلى المصحِّح؛ و dispatchOnlineOrder
  // يُسند الفاتورة لموظّف التجهيز لا المشرف الذي ضغط زرّ الإرسال).
  const sellerUserId = input.attributeToUserId ?? actor.userId;
  const insRes = await tx.insert(invoices).values({
    invoiceNumber,
    sourceType: input.sourceType,
    // TX-01: clientRequestId فارغ ("") يُخزَّن null لا "" — وإلا اصطدم على uq_invoice_source وحجب
    // كل بيعٍ لاحق بلا مفتاح. (|| يَلتقط "" بخلاف ?? الذي يُمرّره.)
    sourceId: input.clientRequestId || null,
    branchId: input.branchId,
    shiftId: input.shiftId ?? null,
    customerId: input.customerId ?? null,
    priceTier: tier,
    // dueDate يُحفظ كـDate إن وُرد، وإلا null. يستعمله AR aging والتنبيهات.
    dueDate: input.dueDate ? new Date(input.dueDate) : null,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    taxRatePercent: round2(money(input.taxRatePercent ?? "0")).toFixed(2),
    discountAmount: totals.discountAmount,
    total: toDbMoney(effectiveTotalD),
    costTotal,
    cashRoundingAdjustment: toDbMoney(cashRoundingAdj),
    // أجرة الشحن كإيراد (مُضمَّنة في total ومُعترَف بها في revenue أدناه) — تُخزَّن صراحةً ليعكسها
    // المرتجع الكامل بدقّة (returnService) فيبقى Σ(revenue)=Σ(profit)=0.
    deliveryFee: toDbMoney(deliveryFeeD),
    // إفصاح التوصيل المجّاني (0152): يُحسَم **خادمياً** — «مجّانيّ» تعني أجرةً صفراً حتماً،
    // فلو وردت أجرةٌ موجبة مع العَلَم فالأجرة تُغلِّب والعَلَم يسقط (لا فاتورةٌ تقول «مجاناً»
    // وتقبض أجرةً في آنٍ واحد). والقيمة المُتنازَل عنها لا تُخزَّن إلّا مع المجّانيّة الفعلية.
    deliveryFree: isFreeDelivery,
    deliveryWaivedAmount: toDbMoney(isFreeDelivery ? waivedDelivery : money(0)),
    status,
    paidAmount: toDbMoney(paidNow),
    paymentMethod: effectiveInvoicePaymentMethod,
    // paymentMode (٢٨/٨/٢٦، هجرة 0276): افتراضي PREPAID للحفاظ على السلوك الحاليّ لكلّ فاتورةٍ
    // بلا مسار COD صريح. يُمرَّر من `checkoutReception` عند طلب توصيلٍ نقديٍّ عند التسليم.
    // ⚠️ Codex #1006 P2 — COD يعني «تحصيلٌ عند التسليم»؛ فبيعٌ بتوصيلٍ **مدفوعٍ كاملاً** عند الإنشاء
    // (لا متبقٍّ تحمله الإرساليّة، ومنه فاتورةُ المطبعة المدفوعة في السلّة المختلطة) هو PREPAID لا COD.
    // نشتقّه من وجود متبقٍّ فعليّ لا من وجود التوصيل وحده (`withDeliveryDefaults` يختمه COD تفاؤلياً).
    paymentMode:
      input.paymentMode === "COD" && unpaid.lte(0)
        ? "PREPAID"
        : (input.paymentMode ?? "PREPAID"),
    paymentDate: paidNow.gt(0) ? new Date() : null,
    notes: input.notes ?? null,
    // ٥/٨ — زبونٌ عابر: مرجعٌ نصّيّ على الفاتورة بلا إنشاء عميل (customerId يبقى NULL ⇒ لا AR).
    contactName: input.contactName?.trim() || null,
    contactPhone: input.contactPhone?.trim() || null,
    // أوفلاين (ش٣): وسم المنشأ + الرقم المؤقّت المطبوع + لحظة الالتقاط الحقيقية —
    // يضبطها offline.replaySale حصراً (saleRouter لا يعرض offlineCapture).
    originatedOffline: !!input.offlineCapture,
    offlineReceiptNumber: input.offlineCapture?.offlineReceiptNumber ?? null,
    capturedAt: input.offlineCapture?.capturedAt ?? null,
    salespersonNameSnapshot,
    posDeviceId: input.offlineCapture?.deviceId ?? input.deviceId ?? null,
    createdBy: sellerUserId,
    // الإسناد التجاري المباشر لسرعة الاستعلام
    salesRepId: attributionPlan.primaryUserId,
    attributionMode: attributionPlan.attributionMode,
  });
  const invoiceId = extractInsertId(insRes);

  // تسجيل تفاصيل الإسناد ذرّياً في جدول invoiceAttributions ضمن نفس المعاملة (withTx)
  await recordInvoiceAttributionsInTx(tx, {
    branchId: input.branchId,
    invoiceId,
    plan: attributionPlan,
    teamPoolId: input.attribution?.teamPoolId ?? null,
  });

  // B5: استهلاك الموافقة (يربطها بالفاتورة الفعلية بعد إنشائها — single-use).
  if (effectiveApprovalId) {
    await consumeApproval(tx, effectiveApprovalId, invoiceId);
  }

  // 9. Items.
  const createdLineItems: { lineToken: string; invoiceItemId: number }[] = [];
  for (const c of computed) {
    const itemInsRes = await tx.insert(invoiceItems).values({
      invoiceId,
      variantId: c.variantId,
      productUnitId: c.productUnitId,
      quantity: c.quantity,
      baseQuantity: c.baseQuantity,
      unitPrice: c.unitPrice,
      unitCost: c.unitCost,
      lineCost: c.lineCost,
      serviceMaterialsSnapshotted: c.kind === "SERVICE",
      discountAmount: c.discountAmount,
      total: c.total,
      // promotions v2: الأثر متجمّد على المستند — تعديل عرضٍ لاحقاً لا يمسّ سجلّ فواتير سابقة.
      promotionId: c.promotionId,
      promotionDiscount: c.promotionDiscount,
      // هدايا الفاتورة (0149): وسمُ السطر المُهدى. `unitCost` أعلاه يحمل تكلفته الحقيقية كاملةً
      // (لقطة WAVG) — مصدرُ مصروف الهدية ومصدرُ عكسِه عند الإرجاع.
      isGift: c.isGift,
      itemNameSnapshot: c.invoiceName,
    });
    const insertedInvoiceItemId = extractInsertId(itemInsRes);
    if (c.internalLineToken) {
      createdLineItems.push({
        lineToken: c.internalLineToken,
        invoiceItemId: insertedInvoiceItemId,
      });
    }
    // gstack B6: لقطة مكوّنات البكج لحظة البيع. المرتجع يقرأ منها حصراً بدل الوصفة الحيّة —
    // يحمي من انحراف مخزون صامت لو عُدّلت الوصفة بين البيع والإرجاع.
    if (c.kind === "BUNDLE") {
      const invoiceItemId = insertedInvoiceItemId;
      const def = bundleDefs.get(c.variantId) ?? [];
      for (const bc of def) {
        await tx.insert(invoiceItemBundleComponents).values({
          invoiceItemId,
          componentVariantId: bc.componentVariantId,
          componentBaseQuantity: bc.componentBaseQuantity,
          issueUnitCost: componentIssueCosts.get(bc.componentVariantId)!,
          issueLineCost: toDbMoney(
            money(componentIssueCosts.get(bc.componentVariantId)!)
              .times(bc.componentBaseQuantity)
              .times(c.baseQuantity),
          ),
        });
      }
    } else if (c.kind === "SERVICE") {
      for (const material of c.serviceMaterials) {
        await tx.insert(invoiceItemServiceMaterials).values({
          invoiceItemId: insertedInvoiceItemId,
          materialVariantId: material.materialVariantId,
          baseQuantity: material.baseQuantity,
          unitCost: material.unitCost,
          lineCost: material.lineCost,
        });
      }
    }
  }

  // الاسترداد جزء من نفس المعاملة: فشل أي قيد/مخزون لاحق يعيد الكوبون كما كان تلقائياً.
  if (lockedCoupon) {
    await consumeCoupon(tx, lockedCoupon, {
      invoiceId,
      customerId: input.customerId ?? null,
      branchId: input.branchId,
      discountAmount: couponDiscount.plus(couponShippingWaivedD).toFixed(2),
      netSales: totals.total,
      userId: actor.userId,
    });
  }

  // 10. Deduct stock (OUT) per line.
  //     bundles (٧/٧/٢٦): البكج لا يملك branchStock — نتخطّاه لصالح **مكوّناته**. نبني قائمة العمليات
  //     المخزنيّة الفعلية أوّلاً ثم نجمّعها بالمتغيّر (بكجان يتشاركان مكوّناً ⇒ حركة واحدة مجمَّعة)
  //     ثم نطبّقها بترتيب variantId التصاعدي — يحافظ على ترتيب القفل الحتميّ (بند 5 أعلاه).
  //     ⚠️ نفس الترتيب مهم للسلامة تحت التزامن: تجميع قبل التطبيق يمنع سباق قفل على نفس الصفّ.
  interface StockOp {
    variantId: number;
    baseQuantity: number;
  }
  const stockOps: StockOp[] = [];
  // مواد الخدمة تُخصم بمسار منفصل بعد الأصناف العادية، لكن بنفس سياسة المخزون الصارمة:
  // بيع الخدمة لا يجوز أن يصنع رصيداً سالباً أو يتجاوز حجزاً قائماً.
  const serviceMaterialOps: StockOp[] = [];
  for (const c of computed) {
    if (c.kind === "BUNDLE") {
      const def = bundleDefs.get(c.variantId) ?? [];
      // في هذه النقطة تحقّقنا سابقاً أن الوصفة غير فارغة (حارس PRECONDITION أعلاه).
      for (const comp of def) {
        stockOps.push({
          variantId: comp.componentVariantId,
          baseQuantity: comp.componentBaseQuantity * c.baseQuantity,
        });
      }
    } else if (c.kind === "SERVICE") {
      // اللقطة التي حُسبت للكلفة هي نفسها مصدر الخصم؛ لا نعيد توسيع وصفة حيّة ثانية.
      for (const material of c.serviceMaterials) {
        serviceMaterialOps.push({
          variantId: material.materialVariantId,
          baseQuantity: material.baseQuantity,
        });
      }
    } else {
      stockOps.push({ variantId: c.variantId, baseQuantity: c.baseQuantity });
    }
  }
  // تجميع بحسب variantId (لتحاشي حركتين على نفس الصنف من بكجين مختلفين — كذلك سطر بكج + سطر مفرد
  // من نفس الصنف يُجمعان في قفلٍ واحد). حساب decimal-free (كل الكميّات صحيحة موجبة).
  const aggregated = new Map<number, number>();
  for (const op of stockOps) {
    aggregated.set(
      op.variantId,
      addQuantities(aggregated.get(op.variantId) ?? 0, op.baseQuantity),
    );
  }
  const sortedVariantIds = Array.from(aggregated.keys()).sort((a, b) => a - b);
  const serviceMaterialAgg = new Map<number, number>();
  for (const op of serviceMaterialOps) {
    serviceMaterialAgg.set(
      op.variantId,
      addQuantities(serviceMaterialAgg.get(op.variantId) ?? 0, op.baseQuantity),
    );
  }
  const serviceMaterialVariantIds = Array.from(serviceMaterialAgg.keys()).sort(
    (a, b) => a - b,
  );
  // «وضع الافتتاح» (ش٢ ١٩/٧): بيعٌ مسدّد بالكامل نقداً أو بالبطاقة من قناة POS
  // يُسمح له بالنزول تحت الصفر للصنف. البطاقة سداد فوري كامل مثل النقد، لكن أثرها
  // المالي يبقى في خزينة البطاقة ولا يدخل درج الكاشير.
  // **غير المُفتتَح** (openedAt IS NULL — يُفحص داخل applyMovement تحت القفل) حتى يُجرَد افتتاحياً.
  // شرطا الأمان الصنفيان (مراجعة عدائية ١٨/٧): تكلفة مُدخلة (>0) — سالبٌ بلا COGS = تسريب غير
  // قابل للكشف — وسقف كمية للسطر يصدّ خطأ الإدخال والاحتيال. قناة الأوفلاين (allowNegativeStock)
  // مستقلة تماماً ولا تتراكب. القراءة كسولة: البيع العادي المكتفي المخزون لا يدفع أي استعلام إضافي.
  // الأهليّة الأساس: بيعٌ مسدَّدٌ بالكامل في الكاونتر (نقداً/بطاقة، unpaid<=0).
  // امتداد الاستقبال (٨/٨): طلب توصيل COD (codDispatchPending) لا يُسدَّد في الكاونتر
  // (المندوب يقبض من الزبون) فـunpaid>0 دائماً — لكن في وضع الافتتاح السالب يعني «غير مجرود»
  // لا «نافد»، والمندوب يحمل الصنف الموجود فعلياً. فنسمح به **بتأكيد توفّرٍ فيزيائيّ صريح**
  // من الموظّف؛ تبقى رِيلات الأمان (تكلفة>0 + سقف الكمية + استثناء الأمانة) نافذةً كما هي أدناه.
  // توسعة قرار المالك (١٠/٨): من «POS مسدّد كاملاً» إلى **كل قنوات الاستقبال/التنفيذ**.
  // نُبقي شروط main الأدقّ للـPOS (كاونتر مسدّد نقداً/بطاقة + COD بتأكيد التوفّر) كما هي دون
  // تخفيف، ونُضيف: قنوات ORDER/WORKORDER (بأي دفع) + بيع POS آجل لعميلٍ محدَّد (البيع الآجل من
  // الاستقبال). الريلات الصنفية أدناه (تكلفة>0 + سقف + غير مُفتتَح + استثناء الأمانة) تبقى نافذة.
  const openingBaseEligible =
    input.strictStock !== true &&
    !input.allowNegativeStock &&
    (input.sourceType === "ORDER" ||
      input.sourceType === "WORKORDER" ||
      ((input.sourceType ?? "POS") === "POS" &&
        ((rawPaymentLegs.length > 0 &&
          rawPaymentLegs.every(
            (leg) => leg.method === "CASH" || leg.method === "CARD",
          ) &&
          unpaid.lte(0)) ||
          (input.codDispatchPending === true &&
            input.openingSellUnavailableConfirmed === true) ||
          // بيع POS آجل من الاستقبال لعميلٍ محدَّد (توسعة ١٠/٨) — يُستثنى COD صراحةً كي يبقى
          // محكوماً بحارس تأكيد التوفّر الفيزيائيّ الخاصّ به (main ٨/٨)، لا يتجاوزه حملُه عميلاً.
          (unpaid.gt(0) &&
            !!input.customerId &&
            input.codDispatchPending !== true))));
  const readOpeningWindow = async () => {
    const om = (
      await tx
        .select()
        .from(openingModeSettings)
        .where(eq(openingModeSettings.id, 1))
        .limit(1)
    )[0];
    return om?.enabled && om.endsAt != null && om.endsAt.getTime() > Date.now()
      ? { maxQty: om.maxNegativeQtyPerLine }
      : null;
  };
  let openingWindow: { maxQty: number } | null = null;
  const deductCosts = new Map<number, string>();
  if (openingBaseEligible) {
    openingWindow = await readOpeningWindow();
    if (openingWindow && sortedVariantIds.length) {
      // تكاليف الأصناف المخصومة فعلياً (مكوّنات البكج لا البكج نفسه).
      const costRows = await tx
        .select({ id: productVariants.id, cost: productVariants.costPrice })
        .from(productVariants)
        .where(inArray(productVariants.id, sortedVariantIds));
      for (const r of costRows)
        deductCosts.set(Number(r.id), String(r.cost ?? "0"));
    }
  }
  const negativeDips: { variantId: number; newQuantity: number }[] = [];

  for (const vid of sortedVariantIds) {
    const qty = aggregated.get(vid)!;
    if (qty <= 0) continue; // احترازي — تجميع كميّات صفريّة لا يجب أن يحصل.
    const openingAllow =
      openingWindow != null &&
      qty <= openingWindow.maxQty &&
      money(deductCosts.get(vid) ?? "0").gt(0) &&
      // بضاعة الأمانة (§٥-ج): لا بيع بالسالب لصنف أمانة في المسار الحيّ — تلفيقُ التزامٍ لبضاعةٍ لم تُودَع.
      !consignByVariant.has(vid);
    try {
      const moved = await applyMovement(tx, {
        variantId: vid,
        branchId: input.branchId,
        baseQuantity: qty,
        movementType: "OUT",
        referenceType: "INVOICE",
        referenceId: invoiceId,
        documentNumber: invoiceNumber,
        createdBy: actor.userId,
        notes: openingAllow
          ? "وضع الافتتاح — بيع/طلب لقناة استقبال مسموح بالسالب لصنف غير مُفتتَح"
          : undefined,
        // أوفلاين (ش٣): البيع الملتقَط دون اتصال يُسجَّل ولو هبط الرصيد تحت الصفر — البضاعة
        // خرجت فعلاً (قرار مالك: سالب موسوم بـoriginatedOffline، يظهر في تقرير المراجعة).
        // **استثناء بضاعة الأمانة (§٥-ج، مرآة حارس وضع الافتتاح أعلاه):** لا بيع بالسالب لصنف
        // أمانة حتى عبر الأوفلاين — بيعُ ما لم يُودَع يُلفّق التزاماً للمودِع (AP) لوحداتٍ لم تصل
        // (استحقاق PURCHASE يتيم أدناه). يُرفض بـCONFLICT فيرتدّ ويُعلَّق لمراجعة المدير كالمسار الحيّ.
        allowNegative:
          input.strictStock !== true &&
          (input.allowNegativeStock ?? false) &&
          !consignByVariant.has(vid),
        allowNegativeUnopened: openingAllow,
        onlineOrderAllocationExemptionId: input.onlineOrderAllocationId,
        formalReservationExemptionBase:
          input.formalReservationExemptions?.[vid],
      });
      // معلومة استشارية للمحاولة الفائزة فقط (لا تُعاد في replay الـidempotency — لا حالة دائمة عليها).
      if (openingAllow && moved.newQuantity < 0)
        negativeDips.push({ variantId: vid, newQuantity: moved.newQuantity });
    } catch (e) {
      // إثراء رسالة الرفض أثناء نافذة الافتتاح: يشرح للكاشير لماذا لم يُسمح بالسالب لهذا السطر.
      if (
        e instanceof TRPCError &&
        e.code === "CONFLICT" &&
        e.message.includes("المخزون غير كافٍ")
      ) {
        const win = openingWindow ?? (await readOpeningWindow());
        if (win) {
          const hint =
            input.codDispatchPending === true &&
            input.openingSellUnavailableConfirmed !== true
              ? "طلب توصيل COD لصنفٍ غير مجرود أثناء الافتتاح يتطلّب تأكيد توفّره فيزيائياً صراحةً قبل الإرسال"
              : !openingBaseEligible
                ? "وضع الافتتاح فعّال، لكن البيع بالسالب للصنف غير المجرود متاحٌ لقنوات الاستقبال/التنفيذ فقط (بيع مباشر مسدّد أو آجل لعميلٍ محدَّد، أو طلب/أمر شغل) — هذه القناة/الحالة خارج النطاق"
                : qty > win.maxQty
                  ? `الكمية تتجاوز سقف السطر السالب في وضع الافتتاح (${win.maxQty} وحدة أساس)`
                  : !money(deductCosts.get(vid) ?? "0").gt(0)
                    ? "البيع بالسالب في وضع الافتتاح يتطلّب تكلفة مُدخلة للصنف — أدخِل تكلفته أولاً"
                    : "الصنف مُفتتَح (مجرود) — رصيده مثبّت والبيع فوقه يخضع للفحص الصارم";
          throw new TRPCError({
            code: "CONFLICT",
            message: `${e.message} — ${hint}`,
          });
        }
      }
      throw e;
    }
  }

  // 10.b مواد الخدمات: خصم صارم بعد stockOps وبترتيب variantId تصاعدي. التجميع per-variant
  //      يمنع حركتين لنفس المادة من خدمتين مختلفتين. المرجع INVOICE يتيح العكس الداخلي الدقيق.
  if (serviceMaterialOps.length) {
    for (const vid of serviceMaterialVariantIds) {
      const qty = serviceMaterialAgg.get(vid)!;
      if (qty <= 0) continue;
      await applyMovement(tx, {
        variantId: vid,
        branchId: input.branchId,
        baseQuantity: qty,
        movementType: "OUT",
        referenceType: "INVOICE",
        referenceId: invoiceId,
        documentNumber: invoiceNumber,
        createdBy: actor.userId,
        // البيع الحي صارم حتى إن كانت المادة «تُباع بالطلب». إعادة تشغيل الأوفلاين وحدها
        // تسجّل العجز لأن الواقعة حدثت فعلاً أثناء الانقطاع.
        allowNegative: input.allowNegativeStock === true,
        respectProductBackorder: false,
        formalReservationExemptionBase:
          input.formalReservationExemptions?.[vid],
        notes: SERVICE_RECIPE_CONSUMPTION_NOTE,
      });
    }
  }

  // 11. SALE ledger entry (revenue = net before tax + أجرة الشحن كإيراد بلا تكلفة).
  const byConsignor = new Map<
    number,
    { paid: ReturnType<typeof money>; gift: ReturnType<typeof money> }
  >();
  let ownedInventoryCost = money(0);
  let ownedGiftInventoryCost = money(0);
  for (const c of computed) {
    const share = money(c.lineCost);
    const cId = consignByVariant.get(c.variantId);
    if (cId != null) {
      const current = byConsignor.get(cId) ?? {
        paid: money(0),
        gift: money(0),
      };
      if (c.isGift) current.gift = current.gift.plus(share);
      else current.paid = current.paid.plus(share);
      byConsignor.set(cId, current);
    } else if (c.isGift) {
      // هدية الخدمة تُستهلك مواد وصفتها فعلياً؛ لا مخزون للخدمة نفسها، لكن موادها أصلٌ خرج.
      ownedGiftInventoryCost = ownedGiftInventoryCost.plus(share);
    } else {
      ownedInventoryCost = ownedInventoryCost.plus(share);
    }
  }
  ownedInventoryCost = round2(ownedInventoryCost);
  ownedGiftInventoryCost = round2(ownedGiftInventoryCost);

  // 11. SALE ledger entry (revenue = net before tax + أجرة الشحن كإيراد بلا تكلفة).
  const revenue = money(totals.subtotal)
    .minus(money(totals.discountAmount))
    .plus(deliveryFeeD);
  // `invoices.costTotal` remains the complete analytical paid-line cost used by sales/job-cost
  // reports. The SALE source field, however, is canonical ledger COGS and must equal only the
  // owned inventory/materials actually credited below. Consignor COGS is disclosed by its
  // PURCHASE_CONSIGNMENT entry, so it must not be duplicated here or represented as INVENTORY.
  const analyticalInvoiceCost = money(costTotal);
  const ledgerOwnedCogs = ownedInventoryCost;
  const merchandiseRevenue = round2(revenue.minus(deliveryFeeD));
  const revenueLines = computed.filter(
    (c) => !c.isGift && money(c.total).gt(0),
  );
  const revenueBasis = revenueLines.reduce(
    (sum, c) => sum.plus(money(c.total)),
    money(0),
  );
  const revenueByRole = new Map<AccountRole, ReturnType<typeof money>>();
  const saleClasses = new Set<
    "DIGITAL" | "SERVICE" | "CONSIGNMENT" | "INVENTORY"
  >();
  let allocatedRevenue = money(0);
  for (let index = 0; index < revenueLines.length; index++) {
    const line = revenueLines[index]!;
    const isDigital =
      variantById.get(line.variantId)?.productType === "DIGITAL_CARD";
    const saleClass = isDigital
      ? "DIGITAL"
      : line.kind === "SERVICE"
        ? "SERVICE"
        : consignByVariant.has(line.variantId)
          ? "CONSIGNMENT"
          : "INVENTORY";
    saleClasses.add(saleClass);
    const role: AccountRole =
      input.sourceType === "WORKORDER"
        ? "SALES_FLEX"
        : isDigital
          ? "OTHER_REVENUE"
          : line.kind === "SERVICE"
            ? "SALES_PRINT"
            : "SALES_STATIONERY";
    const lineRevenue =
      index === revenueLines.length - 1
        ? round2(merchandiseRevenue.minus(allocatedRevenue))
        : round2(merchandiseRevenue.times(money(line.total)).div(revenueBasis));
    allocatedRevenue = allocatedRevenue.plus(lineRevenue);
    revenueByRole.set(
      role,
      round2((revenueByRole.get(role) ?? money(0)).plus(lineRevenue)),
    );
  }
  const saleProfile: PostingProfile =
    input.sourceType === "WORKORDER"
      ? "SALE_SERVICE_FLEX"
      : saleClasses.size > 1
        ? "SALE_MIXED"
        : saleClasses.has("DIGITAL")
          ? "SALE_DIGITAL"
          : saleClasses.has("SERVICE")
            ? "SALE_SERVICE"
            : saleClasses.has("CONSIGNMENT")
              ? "SALE_CONSIGNMENT"
              : "SALE_INVENTORY";
  const appliedCustomerDeposit =
    input.allowPreCollectedOverpay === true ? money(0) : preCollectedD;
  const salePostingLines = [
    ...(money(totals.total).isZero()
      ? []
      : [debitLine("AR", money(totals.total))]),
    ...Array.from(revenueByRole.entries())
      .filter(([, amount]) => !amount.isZero())
      .map(([role, amount]) => creditLine(role, amount)),
    ...(deliveryFeeD.isZero()
      ? []
      : [creditLine("DELIVERY_REVENUE", deliveryFeeD)]),
    ...(money(totals.taxAmount).isZero()
      ? []
      : [creditLine("TAX_PAYABLE", money(totals.taxAmount))]),
    ...(ownedInventoryCost.isZero()
      ? []
      : [
          debitLine("COGS", ownedInventoryCost),
          creditLine("INVENTORY", ownedInventoryCost),
        ]),
    ...(appliedCustomerDeposit.isZero()
      ? []
      : [
          debitLine("OTHER_LIABILITY", appliedCustomerDeposit),
          creditLine("AR", appliedCustomerDeposit),
        ]),
  ];
  const salePostingSource = {
    roleDebits: {
      AR: money(totals.total),
      OTHER_LIABILITY: appliedCustomerDeposit,
      COGS: ownedInventoryCost,
    },
    roleCredits: {
      AR: appliedCustomerDeposit,
      SALES_STATIONERY: revenueByRole.get("SALES_STATIONERY") ?? money(0),
      SALES_PRINT: revenueByRole.get("SALES_PRINT") ?? money(0),
      SALES_FLEX: revenueByRole.get("SALES_FLEX") ?? money(0),
      OTHER_REVENUE: revenueByRole.get("OTHER_REVENUE") ?? money(0),
      DELIVERY_REVENUE: deliveryFeeD,
      TAX_PAYABLE: money(totals.taxAmount),
      INVENTORY: ownedInventoryCost,
      WORK_IN_PROGRESS: money(0),
    },
  };
  const salePostingIntent = salePostingLines.length
    ? createPostingIntent(
        saleProfile,
        "SALE",
        salePostingLines,
        salePostingSource,
      )
    : null;
  // فاتورة هدايا صِرفة لا تملك SALE مالياً؛ قيدها الوحيد GIFT_OUT أدناه. لا ننشئ
  // SALE صفرياً بلا journal profile لأن ذلك ليس حدثاً مالياً في دفتر المبيعات.
  if (salePostingIntent) {
    await postEntry(tx, {
      entryType: "SALE",
      dedupeKey: `SALE:${invoiceId}`, // حارس بنيوي: قيد SALE واحد لكل فاتورة
      branchId: input.branchId,
      invoiceId,
      customerId: input.customerId ?? null,
      revenue,
      cost: ledgerOwnedCogs,
      profit: revenue.minus(ledgerOwnedCogs),
      taxAmount: money(totals.taxAmount),
      amount: money(totals.total),
      createdBy: sellerUserId,
      createdByNameSnapshot: salespersonNameSnapshot,
      notes: analyticalInvoiceCost.eq(ledgerOwnedCogs)
        ? undefined
        : `تكلفة تحليلية للفاتورة=${toDbMoney(analyticalInvoiceCost)}؛ COGS مملوك في قيد البيع=${toDbMoney(ledgerOwnedCogs)}؛ حصة الأمانة في قيود PURCHASE_CONSIGNMENT المستقلة`,
      postingIntent: salePostingIntent,
      postingSourceComponents: salePostingSource,
    });
  }

  // 11.ب هدايا الفاتورة (0149): قيدٌ واحدٌ لتكلفة كلّ البنود المُهداة — مصروف هدايا وترويج
  // (إيراد=0، ربح=−التكلفة) مطابقٌ تماماً لقيد سند الهدية المستقلّ في `gifts/outbound.ts` فلا
  // تنجرف القناتان. يحمل `invoiceId` للتتبّع (أيّ فاتورةٍ أهدت ماذا) ويبقى مع ذلك **خارج وعاء
  // العمولة** لأنّ الوعاء يفلتر `entryType IN ('SALE','RETURN')` — فالبائع لا يُكافأ على إهداء
  // ولا يُعاقَب به. `dedupeKey` حارسٌ بنيويّ: قيد هدايا واحد لكل فاتورة (نظير SALE:${invoiceId}).
  if (giftCostD.gt(0)) {
    const giftPosting = classifyGiftPosting(
      giftCostD,
      ownedGiftInventoryCost,
      1,
    );
    await postEntry(tx, {
      entryType: "GIFT_OUT",
      dedupeKey: `GIFT:INV:${invoiceId}`,
      branchId: input.branchId,
      invoiceId,
      customerId: input.customerId ?? null,
      revenue: money(0),
      cost: giftCostD,
      profit: round2(money(0).minus(giftCostD)),
      amount: giftCostD,
      notes: `هدايا ضمن فاتورة بيع؛ consignmentRemainder=${toDbMoney(giftPosting.consignmentRemainder)}`,
      postingIntent: giftPosting.intent,
      postingSourceComponents: giftPosting.sourceComponents,
    });
  }

  // 11.أ بضاعة الأمانة (ش٣): التقاط التزام المودِع لحظة البيع. طريقة الإجمالي — قيد SALE أعلاه لم يُمسّ
  // (revenue كامل، الربح=الهامش لأن الحصة داخل unitCost). لكل مودِع: قيد PURCHASE **يتيم** بـinvoiceId
  // (المميّز البنيوي PURCHASE∧invoiceId فارغ تاريخياً) بصفر أثر P&L (amount فقط) + رفع رصيده (AP). §٢-ب.
  {
    // ترتيب supplierId تصاعدياً — منع deadlock (مرآة ترتيب variantId في حركات المخزون).
    for (const cId of Array.from(byConsignor.keys()).sort((a, b) => a - b)) {
      const split = byConsignor.get(cId)!;
      const paidShare = round2(split.paid);
      const giftShare = round2(split.gift);
      const amount = round2(paidShare.plus(giftShare));
      if (amount.lte(0)) continue;
      await postEntry(tx, {
        entryType: "PURCHASE",
        supplierId: cId,
        invoiceId,
        branchId: input.branchId,
        amount,
        revenue: money(0),
        cost: paidShare,
        profit: paidShare.neg(),
        dedupeKey: `CONSIG:${invoiceId}:${cId}`,
        notes: `استحقاق أمانة؛ COGS مبسّط=${toDbMoney(paidShare)}؛ هدايا=${toDbMoney(giftShare)}`,
        postingIntent: createPostingIntent(
          "PURCHASE_CONSIGNMENT",
          "PURCHASE",
          [
            ...(paidShare.isZero() ? [] : [debitLine("COGS", paidShare)]),
            ...(giftShare.isZero()
              ? []
              : [debitLine("GIFTS_PROMO", giftShare)]),
            creditLine("CONSIGNMENT_PAYABLE", amount),
          ],
          {
            roleDebits: { COGS: paidShare, GIFTS_PROMO: giftShare },
            roleCredits: { CONSIGNMENT_PAYABLE: amount },
          },
        ),
        postingSourceComponents: {
          roleDebits: { COGS: paidShare, GIFTS_PROMO: giftShare },
          roleCredits: { CONSIGNMENT_PAYABLE: amount },
        },
      });
      await adjustSupplierBalance(tx, cId, amount);
    }
  }

  // 11.b تسوية التقريب النقدي: قيد ADJUST بفرق التقريب ⇒ (SALE.amount + ADJUST.amount) = الإجمالي المقرّب = النقد المستلم.
  // G6 (١٩/٦/٢٦): dedupeKey حارس ضدّ تكرار ADJUST لو حدثت إعادة محاولة بعد ER_DUP_ENTRY
  // (tx.atomicity تحمي نظرياً، لكن dedupeKey defense-in-depth صريح).
  if (!cashRoundingAdj.isZero()) {
    await postEntry(tx, {
      entryType: "ADJUST",
      dedupeKey: `ADJUST:IQD:${invoiceId}`,
      branchId: input.branchId,
      invoiceId,
      customerId: input.customerId ?? null,
      revenue: cashRoundingAdj,
      profit: cashRoundingAdj,
      amount: cashRoundingAdj,
      notes: "تقريب نقدي IQD",
      postingIntent: createPostingIntent(
        "ADJUST_ROUNDING",
        "ADJUST",
        signedPostingLines("AR", "ROUNDING_DIFF", cashRoundingAdj),
      ),
    });
  }

  // 12. Payment + AR.
  //     ش٤ (I5): الإيصال والقيد للجزء **الجديد** وحده (newMoneyD) — المقبوض سلفاً له إيصاله
  //     وقيده منذ لحظة القبض (deposits.ts)، وإنشاء ثانٍ له = نقدٌ وهميّ يمنع إغلاق الوردية.
  //     في الدفعات المقسّمة (Split Payment): تُسجَّل الدفعات غير النقدية بمبالغها الدقيقة أوّلاً
  //     من وعاء newMoneyD، ويُخصَّص المتبقي للدفعات النقدية (بحيث يذهب أيّ فائضٍ نقديّ كباقي للزبون
  //     دون أن يدخل الدرج أو يمسّ مبلغ البطاقة/التحويل).
  const createdReceiptIds: number[] = [];
  if (newMoneyD.gt(0) && rawPaymentLegs.length > 0) {
    let remainingNonCashBudget = newMoneyD.lt(nonCashTenderedD)
      ? newMoneyD
      : nonCashTenderedD;
    const rawCashBudget = round2(newMoneyD.minus(remainingNonCashBudget));
    let remainingCashBudget = rawCashBudget.gt(0) ? rawCashBudget : money(0);
    for (const leg of rawPaymentLegs) {
      const legTenderedD = round2(money(leg.amount));
      if (legTenderedD.lte(0)) continue;
      let legRecordedD: ReturnType<typeof money>;
      if (leg.method === "CASH") {
        legRecordedD = legTenderedD.lt(remainingCashBudget)
          ? legTenderedD
          : remainingCashBudget;
        remainingCashBudget = round2(remainingCashBudget.minus(legRecordedD));
      } else {
        legRecordedD = legTenderedD.lt(remainingNonCashBudget)
          ? legTenderedD
          : remainingNonCashBudget;
        remainingNonCashBudget = round2(
          remainingNonCashBudget.minus(legRecordedD),
        );
      }
      if (legRecordedD.lte(0)) continue;
      const rRes = await tx.insert(receipts).values({
        invoiceId,
        branchId: input.branchId,
        shiftId: input.shiftId ?? null,
        // cashBucket=DRAWER للنقد (يدخل تسوية Z-report)، NULL لغير النقد (لا يَمسّ صندوقاً).
        // مرآة لنمط voucherService — يَحرس مستقبلاً صيَغ reconcile/cashOrphans التي تَفلتر بـcashBucket.
        cashBucket: leg.method === "CASH" ? "DRAWER" : null,
        direction: "IN",
        amount: toDbMoney(legRecordedD),
        paymentMethod: leg.method,
        referenceNumber: leg.reference?.trim() || null,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        createdBy: actor.userId,
      });
      const receiptId = extractInsertId(rRes);
      createdReceiptIds.push(receiptId);
      const paymentRole = paymentAssetRole(
        leg.method,
        leg.method === "CASH" ? "DRAWER" : null,
        "IN",
      );
      const paymentPostingSource = {
        roleDebits: { [paymentRole]: legRecordedD },
        roleCredits: { AR: legRecordedD },
      };
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        branchId: input.branchId,
        invoiceId,
        receiptId,
        customerId: input.customerId ?? null,
        amount: legRecordedD,
        postingIntent: createPostingIntent(
          "PAYMENT_IN_CUSTOMER",
          "PAYMENT_IN",
          [debitLine(paymentRole, legRecordedD), creditLine("AR", legRecordedD)],
          paymentPostingSource,
        ),
        postingSourceComponents: paymentPostingSource,
      });
    }
  }
  // إيصالات المقبوض سلفاً المُمرَّرة صراحةً تُختم بالفاتورة فقط (append-only — نمط deliver.ts).
  for (const preReceiptId of input.preCollected?.receiptIds ?? []) {
    await tx
      .update(receipts)
      .set({ invoiceId })
      .where(
        and(eq(receipts.id, preReceiptId), sql`${receipts.invoiceId} IS NULL`),
      );
  }
  if (input.customerId) {
    await adjustCustomerBalance(
      tx,
      input.customerId,
      effectiveTotalD.minus(paidNow),
    );
    if (effectiveTotalD.gt(paidNow) && !input.deferCustomerSettlement) {
      const settled = await autoSettleCustomerAccountTx(tx, input.customerId, actor);
      if (money(settled.totalSettledAmount).gt(0)) {
        const [current] = await tx.select({ total: invoices.total, paid: invoices.paidAmount, returned: invoices.returnedTotal })
          .from(invoices).where(eq(invoices.id, invoiceId));
        status = computeInvoiceStatus(current.total, current.paid, current.returned ?? "0");
      }
    }
  }
  if (input.clientRequestId && requestFingerprint) {
    await recordIdempotencyKey(
      tx,
      "sale.create",
      input.clientRequestId,
      invoiceId,
      requestFingerprint,
    );
  }

  // ── م١ (PR-1): أمانةُ أجرة التوصيل ثمّ الإسناد — داخل معاملة البيع نفسها ─────────────────
  // (قرار المالك ٦/٨): متبقّي فاتورة التوصيل عهدةٌ على المندوب تُرفع في اللحظة التي تُنشأ فيها
  // الفاتورة — لا لحظةَ واحدة يكون فيها مالٌ بلا مالك: إمّا (فاتورة + إرسالية) معاً وإمّا لا شيء.
  // الترتيب مقصود: إيصال الأمانة أوّلاً — `dispatchInvoiceInTx` يشترط وجوده لقبول COUNTER.
  // Codex #1006/#1012 P2 — احلل أجرةَ الجهة الافتراضيّة مرّةً هنا لتقرأها بوّابةُ الأمانة والإسناد
  // معاً: `delivery.fee = null` يعني `deliveryParties.defaultFee`؛ والمقارنةُ بصفرٍ قبل الحلّ كانت
  // ترفض أمانةً = الأجرة الافتراضية (بوّابة الأمانة)، ثمّ ترفض الأمانة الغائبة (بوّابة COUNTER في الإسناد).
  // م١: أجرة الجهة الافتراضية حُلَّت مسبقاً في `resolvedDeliveryFee` لتقرأها بوّابة التوصيل المجاني
  // وبوّابة الأمانة والإسناد معاً (Codex #1006/#1012 P2).
  const feeHeldD = round2(money(input.deliveryFeeHeld ?? "0"));
  if (feeHeldD.gt(0)) {
    assertDeliveryFeeHeldConsistent(
      feeHeldD,
      input.delivery
        ? {
            fee: resolvedDeliveryFee,
            feeCollection: input.delivery.feeCollection ?? null,
          }
        : null,
    );
    await recordDeliveryFeeHeldInTx(tx, {
      branchId: input.branchId,
      shiftId: input.shiftId ?? null,
      invoiceId,
      amount: feeHeldD,
      tender: input.deliveryFeeTender,
      actorUserId: actor.userId,
      description: "أجرة توصيل مقبوضة أمانةً للمندوب — بيع مباشر",
    });
  }
  let dispatched: { consignmentId: number; consignmentNumber: string } | null =
    null;
  if (input.delivery) {
    const d = await dispatchInvoiceInTx(
      tx,
      {
        invoiceId,
        partyId: input.delivery.partyId,
        assignedUserId: input.delivery.assignedUserId ?? null,
        // م١: الأجرة المحلولة (الافتراضية إن غابت `delivery.fee`) — تقرأها بوّابةُ COUNTER وسطرُ
        // الأجرة معاً، فلا تختلف قيمةُ الفحص عن قيمة الإسناد (Codex #1006/#1012 P2).
        deliveryFee: resolvedDeliveryFee,
        feeCollection: effectiveCourierFeeCollection,
        recipientName:
          input.delivery.recipientName ?? input.contactName ?? null,
        recipientPhone:
          input.delivery.recipientPhone ?? input.contactPhone ?? null,
        deliveryAddress: input.delivery.address ?? null,
        governorate: input.delivery.governorate ?? null,
        externalTrackingRef: input.delivery.externalTrackingRef ?? null,
        clientRequestId: input.clientRequestId
          ? `${input.clientRequestId}-dispatch`
          : null,
      },
      {
        userId: actor.userId,
        branchId: actor.branchId ?? null,
        role: actor.role,
      },
    );
    dispatched = {
      consignmentId: d.consignmentId,
      consignmentNumber: d.consignmentNumber,
    };
  }

  // كوبونات العودة التلقائية (Bounce-Back Coupons) على فواتير الكاشير:
  let bounceBackCoupon: CreateSaleResult["bounceBackCoupon"] = null;
  if (status !== "PENDING" && effectiveTotalD.gt(0)) {
    bounceBackCoupon = await issueBounceBackCouponTx(tx, {
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      invoiceTotal: effectiveTotalD,
      customerTier: tier,
    });
  }

  const totalMerchandisePromoD = round2(
    computed.reduce(
      (sum, line) =>
        line.isGift ? sum : sum.plus(money(line.promotionDiscount)),
      money(0),
    ),
  );
  const appliedOfferNames = Array.from(
    new Set([
      ...computed
        .filter((line) => !line.isGift && money(line.promotionDiscount).gt(0))
        .map((line) => line.promotionName)
        .filter((n): n is string => Boolean(n)),
      ...(isFreeDelivery && authoritativeFreeShippingPromo?.promotionName
        ? [authoritativeFreeShippingPromo.promotionName]
        : []),
    ]),
  );

  return {
    invoiceId,
    invoiceNumber,
    // G3: نُعيد shiftId المُثبَّت الآن — يطابق مسار الـidempotent replay أعلاه.
    shiftId: input.shiftId ?? null,
    total: toDbMoney(effectiveTotalD),
    status,
    createdReceiptId: createdReceiptIds[0] ?? null,
    createdReceiptIds,
    priceOverride: belowCost || manualDiscountGateTriggered,
    // هدايا الفاتورة: تكلفة ما أُهدي (للأثر التدقيقيّ في الراوتر — مَن أهدى وبكم).
    ...(giftCostD.gt(0) ? { giftCost: giftCostD.toFixed(2) } : {}),
    ...(negativeDips.length ? { negativeDips } : {}),
    ...(createdLineItems.length ? { createdLineItems } : {}),
    ...(dispatched ?? {}),
    bounceBackCoupon,
    ...(totalMerchandisePromoD.gt(0) ||
    (isFreeDelivery && authoritativeFreeShippingPromo != null)
      ? {
          promotionSummary: {
            totalMerchandiseDiscount: totalMerchandisePromoD.toFixed(2),
            offerNames: appliedOfferNames,
            freeShippingPromo:
              isFreeDelivery && authoritativeFreeShippingPromo
                ? {
                    promotionId: authoritativeFreeShippingPromo.promotionId,
                    promotionName: authoritativeFreeShippingPromo.promotionName,
                    waivedAmount: waivedDelivery.toFixed(2),
                  }
                : null,
          },
        }
      : {}),
  };
}

export async function createSale(
  input: CreateSaleInput,
  actor: Actor,
): Promise<CreateSaleResult> {
  const result = await withTx(
    async (tx) => createSaleInTx(tx, input, actor),
    { gate: "FINANCIAL_WRITER" },
  );

  // إشعار الشكر (T4.2، خلف مفتاح flowPurchaseThanks) — خارج معاملة البيع تماماً وبعد نجاحها فقط.
  // ⚠️ لا يمسّ ذرّية البيع أبداً: يعمل بعد الالتزام (commit) لا داخله، ومحمي بغلاف دفاعيّ هنا فوق
  // حماية flowNotify الداخلية — فشله (لأي سبب) **لا يُسقِط** بيعاً ناجحاً بالفعل (القاعدة الحاكمة،
  // راجع server/services/whatsapp/flowNotify.ts).
  try {
    await notifySaleCustomerAfterCommit(input, result);
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        invoiceId: result.invoiceId,
      },
      "sale: تعذّر إرسال إشعار الشكر — تُجوهل",
    );
  }

  return result;
}

/** يجلب هاتف/اسم عميل الفاتورة (إن عُرف) ويستدعي flowNotify — لا شيء إن لا عميل/لا هاتف. */
/** Post-commit customer acknowledgement, reusable by composite sale flows. */
export async function notifySaleCustomerAfterCommit(
  input: CreateSaleInput,
  result: CreateSaleResult,
): Promise<void> {
  if (!input.customerId) return;
  const db = requireDb();
  const cust = (
    await db
      .select({ name: customers.name, phone: customers.phone })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1)
  )[0];
  if (!cust?.phone) return;
  await flowNotify({
    flowKey: "flowPurchaseThanks",
    branchId: input.branchId,
    toPhoneE164: cust.phone,
    customerId: input.customerId,
    templateName: "purchase_thanks",
    bodyParams: [cust.name, result.invoiceNumber],
    dedupeKey: `SALE_THANKS:${result.invoiceId}`,
  });
}
