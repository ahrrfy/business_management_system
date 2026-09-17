/**
 * نيّة البيع الرقميّ والتنفيذ الخارجيّ (ش٧).
 *
 * **الخطر الذي تُلغيه هذه الشريحة:** «طُبع الكرت من جهاز المزوّد ثم فشل حفظ البيع فلم يبقَ له أثر».
 * الحلّ: تُسجَّل النيّة **قبل** لمس جهاز المزوّد، ويُسجَّل نجاح كل كرت لحظةَ إصداره. فإذا انهار
 * المتصفّح أو الشبكة بعد ذلك، يبقى الكرت المُصدَر مسجَّلاً في القاعدة وقابلاً للاسترداد الإداريّ.
 *
 * ثوابت لا تُكسَر:
 *   • `prepare` **لا يُنشئ فاتورة ولا يخفض رصيد محفظة** — يحجز فقط (reservedBalance) تحت قفل.
 *   • القفل بترتيب `walletId` تصاعدياً في كل المسارات ⇒ استحالة deadlock بين نيّتين متزامنتين.
 *   • بندٌ سُجِّل `SUCCESS` **لا يُلغى ولا يُحرَّر حجزه أبداً** — لا بالانتهاء ولا بالإلغاء؛
 *     النيّة تنتقل إلى `NEEDS_REVIEW` ويُعالَج الأثر الماليّ بقرارٍ إداريّ صريح.
 *   • تكرار مرجع التنفيذ لدى المزوّد نفسه يمنعه **قيدٌ في القاعدة** (هجرة 0127) لا فحصٌ تطبيقيّ.
 */
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  auditLogs,
  branches,
  digitalCurrentPrices,
  digitalOfferingBranches,
  digitalOfferings,
  digitalPriceVersions,
  digitalProviders,
  digitalSaleIntentItems,
  digitalSaleIntents,
  digitalWalletReservations,
  digitalWallets,
  products,
  productUnits,
  productVariants,
  shifts,
  suppliers,
  users,
} from "../../../drizzle/schema";
import { normalizeDigitalSaleReference } from "../../../shared/digitalSale";
import type { DigitalCheckoutRegularLineInput } from "../../../shared/digitalSale";
import type { PriceTier } from "../pricing";
import { appErrorMessage } from "../../../shared/errors";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { normalizeIraqPhoneE164, phoneSuffix10 } from "../../lib/phone";
import { assertCreditLimit } from "../../lib/credit";
import { createApproval } from "../creditApprovalService";
import { readOpeningWindowState } from "../openingModeService";
import {
  invoiceDiscountExceedsThreshold,
  lineDiscountExceedsThreshold,
} from "../billing";
import { GIFT_APPROVAL_THRESHOLD } from "../gifts/outbound";
import { money, sumMoney, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import type { Actor } from "../tx";
import { redactAuditValue } from "../auditService";
import { lockConfirmedExternalPaymentAttempt } from "../posExternalPayment";
import {
  assertCheckoutReplay,
  prepareCheckoutSnapshot,
  VERIFIED_DIGITAL_PRICE_APPROVAL,
} from "./mixedCartService";
import {
  assertInvoiceFullPayment,
  assertInvoiceLinePartition,
  assertInvoiceSourceEnvelope,
  computeInvoiceIntentTotal,
  parseInvoiceSourcePayload,
  type InvoiceSourcePayload,
} from "./intentSchemas";
import {
  intentInventoryExemptions,
  releaseIntentInventory,
  reserveIntentInventory,
} from "./inventoryReservationService";

/* ────────── الأنواع ────────── */

export interface PrepareLine {
  /** مفتاح السطر من السلة — يجعل كرتين من الفئة نفسها بندَين مستقلَّين. */
  lineKey: string;
  offeringId: number;
  /** إصدار السعر الذي عُرض للزبون — يُقارَن بالنافذ خادمياً ويُرفض إن انحرف. */
  priceVersionId: number;
  /** السعر كما عُرض — يُقارَن ولا يُوثَق به. */
  expectedSellPrice: string;
  /** الرقم الذي أدخله/مسحه الموظف قبل إضافة السطر للسلة؛ سجل داخلي بلا تحقق خارجي. */
  providerReference: string;
  /** بطاقات عملية مزوّد واحدة؛ غيابه يبقي عقد البطاقة المنفردة القديم. */
  providerBasketKey?: string;
  student?: SaleStudentSnapshot | null;
}

/** بيانات البيع فقط؛ لا عقد ولا ملفّ طالب ولا تتبّع انتهاء. */
export interface SaleStudentSnapshot {
  studentName: string;
  studentPhone: string;
  /** حقول قديمة تُقبل للطلبات القديمة فقط ولا تعود مطلوبة في نقطة البيع. */
  customerId?: number | null;
  guardianPhone?: string | null;
  address?: string | null;
  mode?: "UPDATE_PROFILE" | "INVOICE_ONLY";
}

export interface PrepareInput {
  clientRequestId: string;
  branchId: number;
  shiftId: number;
  paymentMethod: string;
  externalPaymentAttemptId?: number | null;
  externalPaymentDeviceId?: string | null;
  cartFingerprint: string;
  lines: PrepareLine[];
  customerId?: number | null;
  priceTier?: PriceTier | null;
  dueDate?: string | null;
  notes?: string | null;
  regularLines?: DigitalCheckoutRegularLineInput[];
  sourceType?: "POS" | "INVOICE" | "RECEPTION";
  sourcePayload?: unknown;
  /** داخلي فقط؛ يحقنه الراوتر بعد التحقق من هوية المدير. */
  managerOverrideByUserId?: number;
  /** process-local capability: cannot be supplied over JSON. */
  priceApprovalCapability?: typeof VERIFIED_DIGITAL_PRICE_APPROVAL;
  priceApprovedBy?: number | null;
}

/** مهلة النيّة: نافذةٌ معقولة لإصدار الكروت من جهاز المزوّد قبل أن تُعتبر مهجورة. */
const INTENT_TTL_MINUTES = 30;

/** Short, renewable lease for the physical/provider issuance step. */
const EXECUTION_CLAIM_TTL_MINUTES = 10;

/** طرق الدفع المسموحة للبيع الرقميّ (§٢ من الوثيقة: لا آجل على الكروت في الإصدار الأول). */
const ALLOWED_PAYMENT_METHODS = new Set(["CASH", "CARD", "CREDIT"]);

function normalizeSaleStudent(input: SaleStudentSnapshot): SaleStudentSnapshot {
  const studentName = input.studentName.trim();
  if (!studentName) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم الطالب مطلوب" });
  const studentPhone = normalizeIraqPhoneE164(input.studentPhone);
  if ((phoneSuffix10(studentPhone) ?? "").length < 10) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "هاتف الطالب غير صالح — أدخل رقماً عراقياً كاملاً" });
  }
  return {
    studentName,
    studentPhone,
    customerId: null,
    guardianPhone: input.guardianPhone?.trim() || null,
    address: input.address?.trim() || null,
    mode: "INVOICE_ONLY",
  };
}

async function auditLog(tx: Tx, actor: Actor, action: string, entityId: number, details: unknown): Promise<void> {
  try {
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId,
      action,
      entityType: "digitalSaleIntent",
      entityId: String(entityId),
      newValue: redactAuditValue(details),
    });
  } catch {
    // best-effort
  }
}

function normalizeIntentSource(input: PrepareInput): {
  input: PrepareInput;
  invoicePayload: InvoiceSourcePayload | null;
} {
  if (input.sourceType === "RECEPTION") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر إصدار الكروت من سلة الاستقبال",
        why: "مسار الاستقبال غير مفعّل بعقد مالي ومخزني آمن بعد",
        doThis: "أنشئ البيع من نقطة البيع أو فاتورة البيع النقدية",
      }),
    });
  }
  if (input.sourceType === "INVOICE") {
    const invoicePayload = parseInvoiceSourcePayload(input.sourcePayload);
    assertInvoiceSourceEnvelope(invoicePayload, {
      branchId: input.branchId,
      shiftId: input.shiftId,
      customerId: input.customerId,
      priceTier: input.priceTier,
      clientRequestId: input.clientRequestId,
    });
    assertInvoiceLinePartition(invoicePayload, input.regularLines ?? []);
    return {
      input: { ...input, sourcePayload: invoicePayload },
      invoicePayload,
    };
  }
  if (input.sourcePayload != null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إعداد سلة نقطة البيع الرقمية",
        why: "الطلب يحمل حمولة مصدر إضافية لا يستعملها مسار نقطة البيع",
        doThis: "أعد فتح السلة من نقطة البيع ثم أرسلها بلا بيانات فاتورة أو استقبال",
      }),
    });
  }
  return { input: { ...input, sourcePayload: undefined }, invoicePayload: null };
}

/* ────────── إعداد النيّة ────────── */

export async function prepare(
  tx: Tx,
  input: PrepareInput,
  actor: Actor,
): Promise<{ intentId: number; replay: boolean; expiresAt: Date }> {
  const normalizedSource = normalizeIntentSource(input);
  input = normalizedSource.input;
  const invoicePayload = normalizedSource.invoicePayload;
  // يسبق replay حتى لا تعبر نيّة تاريخية CREDIT/طريقة معطّلة إلى claim ثم تفشل بعد الإصدار.
  if (!ALLOWED_PAYMENT_METHODS.has(input.paymentMethod)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إعداد البيع الرقمي",
        why: `طريقة الدفع ${input.paymentMethod} غير مدعومة لهذا المسار`,
        doThis: "اختر الدفع النقدي للسلة الجديدة أو راجع النيّة التاريخية من طابور المراجعة",
      }),
    });
  }
  // idempotency: نقرة مزدوجة/إعادة إرسال بنفس المفتاح تُعيد النيّة القائمة بدل حجزٍ ثانٍ.
  const [existing] = await tx
    .select({
      id: digitalSaleIntents.id,
      expiresAt: digitalSaleIntents.expiresAt,
      status: digitalSaleIntents.status,
      fp: digitalSaleIntents.cartFingerprint,
      branchId: digitalSaleIntents.branchId,
      shiftId: digitalSaleIntents.shiftId,
      createdBy: digitalSaleIntents.createdBy,
      paymentMethod: digitalSaleIntents.paymentMethod,
      expectedTotal: digitalSaleIntents.expectedTotal,
      externalPaymentAttemptId: digitalSaleIntents.externalPaymentAttemptId,
      externalPaymentDeviceId: digitalSaleIntents.externalPaymentDeviceId,
      checkoutSnapshot: digitalSaleIntents.checkoutSnapshot,
    })
    .from(digitalSaleIntents)
    .where(eq(digitalSaleIntents.clientRequestId, input.clientRequestId))
    .limit(1);
  if (existing) {
    if (
      existing.fp !== (existing.checkoutSnapshot == null ? input.cartFingerprint : digitalCartFingerprint(input)) ||
      Number(existing.branchId) !== input.branchId ||
      Number(existing.shiftId) !== input.shiftId ||
      existing.paymentMethod !== input.paymentMethod ||
      (existing.externalPaymentAttemptId == null ? null : Number(existing.externalPaymentAttemptId)) !== (input.externalPaymentAttemptId ?? null) ||
      (existing.externalPaymentDeviceId ?? null) !== (input.externalPaymentDeviceId?.trim() || null) ||
      ((actor.role !== "admin" && actor.role !== "manager") && Number(existing.createdBy) !== actor.userId)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "نفس مفتاح الطلب استُعمل لسلّةٍ مختلفة أو سياق بيع مختلف — ابدأ طلباً جديداً",
      });
    }
    assertCheckoutReplay(existing.checkoutSnapshot, input);
    if (!["PREPARED", "EXECUTING", "EXECUTED"].includes(existing.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "المحاولة السابقة أُغلقت — ابدأ طلباً جديداً قبل إعادة بيع الكروت",
      });
    }
    if (existing.paymentMethod === "CARD" && input.externalPaymentAttemptId != null) {
      await lockConfirmedExternalPaymentAttempt(tx, {
        branchId: input.branchId,
        channel: "POS",
        method: "CARD",
        amount: existing.expectedTotal,
        attemptId: input.externalPaymentAttemptId,
        deviceId: input.externalPaymentDeviceId,
        digitalSaleIntentId: Number(existing.id),
      }, actor);
    }
    return { intentId: Number(existing.id), replay: true, expiresAt: existing.expiresAt };
  }

  // فواتير البيع كانت تؤكد عملية البطاقة الخارجية قبل إنشاء النيّة وحجز المخزون.
  // أي رفض لاحق (سعر/مخزون/اعتماد) يترك قبضاً مؤكداً بلا فاتورة ولا مسار عكس آلي.
  // أبقِ replay/الإنقاذ للنيات التاريخية أعلاه، لكن لا تنشئ مخاطرة جديدة حتى يصبح
  // الربط مرحلتين: PREPARED -> external payment -> READY_TO_ISSUE.
  if (input.paymentMethod === "CARD" || input.paymentMethod === "CREDIT") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر إنشاء بيع رقمي غير نقدي",
        why: "المسار موقوف مؤقتاً حتى يكتمل الربط الذري للدفع والذمّة قبل الإصدار",
        doThis: "استخدم الدفع النقدي لهذه السلة ولا تمرّر البطاقة أو تسجّل ذمّة يدوياً",
      }),
    });
  }

  if (!input.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا كروت في السلة" });
  }
  if (
    (input.paymentMethod === "CREDIT" && input.sourceType !== "INVOICE") ||
    (input.paymentMethod !== "CREDIT" && !ALLOWED_PAYMENT_METHODS.has(input.paymentMethod))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "البيع الرقميّ نقداً أو ببطاقة فقط — لا آجل على الكروت",
    });
  }
  if (input.paymentMethod === "CREDIT" && input.customerId == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إعداد بيع الكروت والاشتراكات بالآجل",
        why: "الفاتورة لا تحمل عميلاً مسجّلاً تُرحّل الذمّة عليه",
        doThis: "اختر عميلاً من سجل العملاء ثم أعد الحفظ",
      }),
    });
  }
  if (
    input.paymentMethod === "CREDIT" &&
    (input.externalPaymentAttemptId != null || input.externalPaymentDeviceId?.trim())
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إعداد البيع الآجل",
        why: "الطلب يحمل محاولة دفع أو جهاز دفع خارجي مع أنه لا يسجّل قبضاً",
        doThis: "ألغِ بيانات الدفع الخارجي ثم أعد إعداد الفاتورة كذمّة كاملة",
      }),
    });
  }
  if (input.paymentMethod === "CASH" && input.externalPaymentAttemptId != null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الدفع النقدي لا يحمل محاولة دفع خارجية" });
  }
  if (input.externalPaymentAttemptId == null && input.externalPaymentDeviceId?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُربط جهاز دفع بلا محاولة دفع خارجية" });
  }
  const keys = new Set(input.lines.map((l) => l.lineKey));
  if (keys.size !== input.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مفاتيح أسطر مكرّرة في السلة" });
  }

  // وردية مفتوحة ومملوكة للفاعل في الفرع نفسه.
  const [shift] = await tx
    .select({ id: shifts.id, branchId: shifts.branchId, userId: shifts.userId, status: shifts.status })
    .from(shifts)
    .where(eq(shifts.id, input.shiftId))
    .for("update")
    .limit(1);
  if (!shift || shift.status !== "OPEN") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا وردية مفتوحة" });
  }
  if (Number(shift.branchId) !== input.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الوردية تخصّ فرعاً آخر" });
  }
  if (Number(shift.userId) !== actor.userId && actor.role !== "admin" && actor.role !== "manager") {
    throw new TRPCError({ code: "FORBIDDEN", message: "الوردية تخصّ مستخدماً آخر" });
  }

  const [branch] = await tx
    .select({ id: branches.id, isActive: branches.isActive })
    .from(branches)
    .where(eq(branches.id, input.branchId))
    .limit(1);
  if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
  if (branch.isActive !== true) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر إصدار البطاقات",
        why: "الفرع معطّل ولا يقبل عمليات بيع جديدة",
        doThis: "اختر فرعاً فعالاً أو اطلب من المدير تفعيل الفرع قبل إعادة المحاولة",
      }),
    });
  }

  // تحقّق كل بند مقابل الحالة الخادمية اللحظية.
  type Resolved = {
    line: PrepareLine;
    offeringId: number;
    variantId: number;
    productUnitId: number;
    providerId: number;
    settlementMode: string;
    walletId: number | null;
    name: string;
    requiresStudentData: boolean;
    sellPrice: string;
    providerShare: string;
    margin: string;
    priceVersionId: number;
    student: SaleStudentSnapshot | null;
    providerReference: string;
  };
  const resolved: Resolved[] = [];

  for (const line of input.lines) {
    const [row] = await tx
      .select({
        offeringId: digitalOfferings.id,
        variantId: digitalOfferings.variantId,
        productUnitId: digitalOfferings.productUnitId,
        providerId: digitalOfferings.providerId,
        name: products.name,
        isActive: digitalOfferings.isActive,
        productActive: products.isActive,
        productType: products.productType,
        productIsService: products.isService,
        productIsBundle: products.isBundle,
        productIsConsignment: products.isConsignment,
        variantActive: productVariants.isActive,
        unitActive: productUnits.isActive,
        unitIsBase: productUnits.isBaseUnit,
        requiresStudentData: digitalOfferings.requiresStudentData,
        priceValidityHours: digitalOfferings.priceValidityHours,
        providerActive: digitalProviders.isActive,
        settlementMode: digitalProviders.settlementMode,
        branchActive: digitalOfferingBranches.isActive,
        catalogBranchActive: branches.isActive,
        walletId: digitalOfferingBranches.walletId,
        currentVersionId: digitalCurrentPrices.priceVersionId,
        sellPrice: digitalPriceVersions.sellPrice,
        providerShare: digitalPriceVersions.providerShare,
        margin: digitalPriceVersions.marginAmount,
        validFrom: digitalPriceVersions.validFrom,
        validUntil: digitalPriceVersions.validUntil,
      })
      .from(digitalOfferings)
      .innerJoin(products, eq(digitalOfferings.productId, products.id))
      .innerJoin(
        productVariants,
        and(
          eq(digitalOfferings.variantId, productVariants.id),
          eq(productVariants.productId, products.id),
        ),
      )
      .innerJoin(
        productUnits,
        and(
          eq(digitalOfferings.productUnitId, productUnits.id),
          eq(productUnits.variantId, productVariants.id),
        ),
      )
      .innerJoin(digitalProviders, eq(digitalOfferings.providerId, digitalProviders.id))
      .innerJoin(
        digitalOfferingBranches,
        and(
          eq(digitalOfferingBranches.offeringId, digitalOfferings.id),
          eq(digitalOfferingBranches.branchId, input.branchId),
        ),
      )
      .innerJoin(branches, eq(digitalOfferingBranches.branchId, branches.id))
      .leftJoin(
        digitalCurrentPrices,
        and(
          eq(digitalCurrentPrices.offeringId, digitalOfferings.id),
          eq(digitalCurrentPrices.branchId, input.branchId),
        ),
      )
      .leftJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
      .where(eq(digitalOfferings.id, line.offeringId))
      .limit(1);

    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "بطاقة غير متاحة في هذا الفرع" });
    if (
      row.isActive !== true ||
      row.providerActive !== true ||
      row.branchActive !== true ||
      row.catalogBranchActive !== true
    ) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.name}» لم تعد متاحة للبيع` });
    }
    if (
      row.productType !== "DIGITAL_CARD" ||
      row.productIsService !== true ||
      row.productIsBundle === true ||
      row.productIsConsignment === true ||
      row.productActive !== true ||
      row.variantActive !== true ||
      row.unitActive !== true ||
      row.unitIsBase !== true
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر إعداد البطاقة «${row.name}»`,
          why: "ربط المنتج أو المتغيّر أو وحدة الأساس الرقمية غير صالح أو معطّل",
          doThis: "أعد تفعيل ربط الكتالوج الصحيح ثم أضف البطاقة إلى السلة من جديد",
        }),
      });
    }
    if (row.currentVersionId == null || row.sellPrice == null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.name}» بلا سعر منشور` });
    }
    if (Number(row.currentVersionId) !== line.priceVersionId) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `تغيّر سعر «${row.name}» — أزِل الكرت وأعِد إضافته بالسعر الجديد`,
      });
    }
    if (row.validUntil != null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `انتهى سريان سعر «${row.name}»` });
    }
    if (row.priceValidityHours != null && row.validFrom != null) {
      const ageHours = (Date.now() - new Date(row.validFrom).getTime()) / 3_600_000;
      if (ageHours > row.priceValidityHours) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `سعر «${row.name}» يحتاج تحديثاً` });
      }
    }
    if (!money(line.expectedSellPrice).eq(money(row.sellPrice))) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `سعر «${row.name}» في الشاشة لا يطابق سعر الخادم — حدّث السلة`,
      });
    }

    const providerReference = normalizeDigitalSaleReference(line.providerReference);
    if (!providerReference) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `أدخل رقم العملية أو رقم الاشتراك لـ«${row.name}» قبل البيع`,
      });
    }
    if (providerReference.length > 120) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `الرقم المرجعي لـ«${row.name}» أطول من الحد المسموح` });
    }

    let student: SaleStudentSnapshot | null = null;
    if (row.requiresStudentData) {
      if (!line.student) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.name}» يتطلّب بيانات الطالب` });
      }
      student = normalizeSaleStudent(line.student);
    } else if (line.student) {
      // بند غير تعليميّ يجب أن تبقى حقول الطالب فارغة (§٥.٩).
      throw new TRPCError({ code: "BAD_REQUEST", message: `«${row.name}» لا يقبل بيانات طالب` });
    }

    if (row.settlementMode === "PREPAID" && row.walletId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `«${row.name}» مزوّده مسبق الدفع بلا محفظة مربوطة بهذا الفرع`,
      });
    }

    resolved.push({
      line,
      offeringId: Number(row.offeringId),
      variantId: Number(row.variantId),
      productUnitId: Number(row.productUnitId),
      providerId: Number(row.providerId),
      settlementMode: row.settlementMode,
      walletId: row.walletId != null ? Number(row.walletId) : null,
      name: row.name,
      requiresStudentData: row.requiresStudentData,
      sellPrice: row.sellPrice,
      providerShare: row.providerShare!,
      margin: row.margin!,
      priceVersionId: Number(row.currentVersionId),
      student,
      providerReference,
    });
  }

  const referenceKeys = new Set<string>();
  const baskets = new Map<string, { providerId: number; providerReference: string }>();
  for (const r of resolved) {
    const basketKey = r.line.providerBasketKey?.toLowerCase();
    if (basketKey != null) {
      if (!basketKey.trim() || basketKey.length > 64 || basketKey !== basketKey.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر تجميع البطاقات", why: "معرّف السلة غير صالح", doThis: "أعد إضافة السلة" }) });
      }
      const basket = baskets.get(basketKey);
      if (basket) {
        if (basket.providerId !== r.providerId || basket.providerReference !== r.providerReference) {
          throw new TRPCError({ code: "BAD_REQUEST", message: appErrorMessage({ what: "تعذّر تجميع البطاقات", why: "كل سلة تتطلب مزوّداً واحداً ورقم عملية واحداً", doThis: "افصل عمليات المزوّدين في سلال مستقلة" }) });
        }
        continue;
      }
      baskets.set(basketKey, { providerId: r.providerId, providerReference: r.providerReference });
    }
    const key = `${r.providerId}:${r.providerReference.toLocaleLowerCase("en")}`;
    if (referenceKeys.has(key)) {
      throw new TRPCError({ code: "CONFLICT", message: "الرقم نفسه مضاف مرتين للمزوّد نفسه في السلة" });
    }
    referenceKeys.add(key);
  }

  // حجز أرصدة المحافظ المسبقة: **قفلٌ بترتيب walletId تصاعدياً** (منع deadlock)، والكفاية
  // تُحسب على المتاح = الرصيد − المحجوز الفعّال، لا على الرصيد وحده.
  const needByWallet = new Map<number, string[]>();
  for (const r of resolved) {
    if (r.settlementMode !== "PREPAID" || r.walletId == null) continue;
    const list = needByWallet.get(r.walletId) ?? [];
    list.push(r.providerShare);
    needByWallet.set(r.walletId, list);
  }
  const walletIds = Array.from(needByWallet.keys()).sort((a, b) => a - b);
  const walletIdsByProvider = new Map<number, Set<number>>();
  for (const r of resolved) {
    if (r.walletId == null) continue;
    const set = walletIdsByProvider.get(r.providerId) ?? new Set<number>();
    set.add(r.walletId);
    walletIdsByProvider.set(r.providerId, set);
  }
  for (const [providerId, ids] of Array.from(walletIdsByProvider.entries())) {
    if (ids.size > 1) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا تُجمع بطاقات المزوّد ${providerId} من محافظ متعددة في عملية واحدة`,
      });
    }
  }

  const expiresAt = new Date(Date.now() + INTENT_TTL_MINUTES * 60_000);
  const checkoutBase = await prepareCheckoutSnapshot(
    tx,
    { ...input, managerApprovedByUserId: input.managerOverrideByUserId ?? null },
    actor,
  );
  const digitalPriceLines = resolved.map((r) => ({
    lineKey: r.line.lineKey,
    variantId: r.variantId,
    productUnitId: r.productUnitId,
    sellPrice: r.sellPrice,
  }));
  let expectedTotal: string;
  if (invoicePayload) {
    const invoicePricing = computeInvoiceIntentTotal({
      regularSubtotal: checkoutBase.expectedSubtotal,
      digitalLines: digitalPriceLines,
      sourcePayload: invoicePayload,
    });
    const regularGuard = checkoutBase.pricingGuard;
    if (!regularGuard) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "تعذّر إنشاء لقطة حوكمة السعر قبل إصدار الكروت",
      });
    }
    const digitalPaid = resolved.filter(
      (line) =>
        invoicePricing.digitalSourceLines.get(line.line.lineKey)?.isGift !== true,
    );
    const digitalGifts = resolved.filter(
      (line) =>
        invoicePricing.digitalSourceLines.get(line.line.lineKey)?.isGift === true,
    );
    const digitalLineBelowCost = digitalPaid.some((line) =>
      money(invoicePricing.digitalLineTotals.get(line.line.lineKey) ?? "0").lt(
        money(line.providerShare),
      ),
    );
    const digitalManualDiscount = digitalPaid.some((line) =>
      lineDiscountExceedsThreshold(
        money(line.sellPrice),
        money(1),
        invoicePricing.digitalLineTotals.get(line.line.lineKey) ?? "0",
      ),
    );
    const paidCostTotal = money(regularGuard.paidCostTotal).plus(
      sumMoney(digitalPaid.map((line) => line.providerShare)),
    );
    const giftCostTotal = money(regularGuard.giftCostTotal).plus(
      sumMoney(digitalGifts.map((line) => line.providerShare)),
    );
    const referenceGross = money(regularGuard.referenceGrossTotal).plus(
      sumMoney(digitalPaid.map((line) => line.sellPrice)),
    );
    const invoiceNet = money(invoicePricing.subtotal).minus(
      money(invoicePricing.discountAmount),
    );
    const belowCost =
      regularGuard.paidLineBelowCost ||
      digitalLineBelowCost ||
      invoiceNet.lt(paidCostTotal);
    const manualDiscount =
      regularGuard.manualLineDiscountGate ||
      digitalManualDiscount ||
      invoiceDiscountExceedsThreshold(referenceGross, invoiceNet);
    const giftApprovalNeeded = giftCostTotal.gt(money(GIFT_APPROVAL_THRESHOLD));
    if (
      (belowCost || manualDiscount || giftApprovalNeeded) &&
      checkoutBase.priceOverrideApproved !== true
    ) {
      const why = belowCost
        ? "بيع بأقل من التكلفة"
        : giftApprovalNeeded
          ? "تكلفة الهدايا تتجاوز حد الإهداء"
          : "الخصم يتجاوز الحد المسموح";
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر اعتماد أسعار الفاتورة الرقمية",
          why,
          doThis: "احصل على اعتماد مدير ثم أعد الحفظ قبل إصدار أي كرت",
        }),
      });
    }
    expectedTotal = invoicePricing.total;
    assertInvoiceFullPayment(invoicePayload, {
      paymentMethod: input.paymentMethod,
      paymentAmount: expectedTotal,
      externalPaymentAttemptId: input.externalPaymentAttemptId,
      externalPaymentDeviceId: input.externalPaymentDeviceId,
    });
  } else {
    expectedTotal = toDbMoney(
      sumMoney(resolved.map((r) => r.sellPrice)).plus(
        money(checkoutBase.expectedSubtotal),
      ),
    );
    if (
      resolved.some((line) => money(line.sellPrice).lt(money(line.providerShare))) &&
      checkoutBase.priceOverrideApproved !== true
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر اعتماد سعر الكرت",
          why: "سعر البيع أقل من حصة المزوّد",
          doThis: "صحّح السعر أو احصل على اعتماد مدير قبل الإصدار",
        }),
      });
    }
  }

  // يبقى عقد CREDIT التاريخي قابلاً للتعافي، بينما إنشاء نيات غير نقدية جديدة
  // موقوف أعلاه قبل الوصول إلى هذه الكتلة.
  let creditApprovalId: number | null = null;
  if (input.paymentMethod === "CREDIT") {
    const customerId = input.customerId!;
    if (input.managerOverrideByUserId != null) {
      const approval = await createApproval(tx, {
        customerId,
        branchId: input.branchId,
        maxAmount: expectedTotal,
        approvedBy: input.managerOverrideByUserId,
        ttlMinutes: INTENT_TTL_MINUTES,
        notes: "digital-card credit approved before provider issuance",
      });
      creditApprovalId = approval.id;
    } else {
      const opening = await readOpeningWindowState(tx);
      if (!opening.active) {
        await assertCreditLimit(
          tx,
          customerId,
          expectedTotal,
          input.branchId,
          "CREDIT",
        );
      }
    }
  }
  const checkoutSnapshot = { ...checkoutBase, creditApprovalId };

  let intentId: number;
  try {
    const intentRes = await tx.insert(digitalSaleIntents).values({
      clientRequestId: input.clientRequestId,
      branchId: input.branchId,
      shiftId: input.shiftId,
      createdBy: actor.userId,
      status: "PREPARED",
      cartFingerprint: digitalCartFingerprint(input),
      checkoutSnapshot,
      paymentMethod: input.paymentMethod,
      externalPaymentAttemptId: input.externalPaymentAttemptId ?? null,
      externalPaymentDeviceId: input.externalPaymentDeviceId?.trim() || null,
      expectedTotal,
      expiresAt,
    });
    intentId = extractInsertId(intentRes);
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    // سباق نقرتين: القراءة المقفلة current-read ترى الفائز بعد حسم قيد UNIQUE حتى تحت RR.
    const [winner] = await tx
      .select({
        id: digitalSaleIntents.id,
        expiresAt: digitalSaleIntents.expiresAt,
        status: digitalSaleIntents.status,
        fp: digitalSaleIntents.cartFingerprint,
        branchId: digitalSaleIntents.branchId,
        shiftId: digitalSaleIntents.shiftId,
        createdBy: digitalSaleIntents.createdBy,
        paymentMethod: digitalSaleIntents.paymentMethod,
        expectedTotal: digitalSaleIntents.expectedTotal,
        externalPaymentAttemptId: digitalSaleIntents.externalPaymentAttemptId,
        externalPaymentDeviceId: digitalSaleIntents.externalPaymentDeviceId,
        checkoutSnapshot: digitalSaleIntents.checkoutSnapshot,
      })
      .from(digitalSaleIntents)
      .where(eq(digitalSaleIntents.clientRequestId, input.clientRequestId))
      .for("update")
      .limit(1);
    if (!winner) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تثبيت نيّة البيع الرقمي",
          why: "محاولة الدفع أو مفتاح النيّة مستخدم في عملية أخرى",
          doThis: "لا تُعِد القبض أو الإصدار؛ افتح العملية القائمة وراجع نتيجتها",
        }),
      });
    }
    if (
      winner.fp !== digitalCartFingerprint(input) ||
      Number(winner.branchId) !== input.branchId ||
      Number(winner.shiftId) !== input.shiftId ||
      winner.paymentMethod !== input.paymentMethod ||
      !money(winner.expectedTotal).eq(money(expectedTotal)) ||
      (winner.externalPaymentAttemptId == null
        ? null
        : Number(winner.externalPaymentAttemptId)) !==
        (input.externalPaymentAttemptId ?? null) ||
      (winner.externalPaymentDeviceId ?? null) !==
        (input.externalPaymentDeviceId?.trim() || null) ||
      ((actor.role !== "admin" && actor.role !== "manager") &&
        Number(winner.createdBy) !== actor.userId)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر استعادة محاولة البيع المتزامنة",
          why: "مفتاح الطلب مرتبط بسلة أو سياق بيع مختلف",
          doThis: "لا تُعِد القبض أو الإصدار؛ ابدأ طلباً جديداً بمفتاح جديد",
        }),
      });
    }
    assertCheckoutReplay(winner.checkoutSnapshot, input);
    if (!["PREPARED", "EXECUTING", "EXECUTED"].includes(winner.status)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر متابعة المحاولة المتزامنة",
          why: "المحاولة الفائزة أُغلقت ولم تعد تقبل الإصدار",
          doThis: "راجع نتيجتها ثم ابدأ طلباً جديداً إن لم توجد فاتورة",
        }),
      });
    }
    if (input.paymentMethod === "CARD") {
      await lockConfirmedExternalPaymentAttempt(tx, {
        branchId: input.branchId,
        channel: "POS",
        method: "CARD",
        amount: winner.expectedTotal,
        attemptId: input.externalPaymentAttemptId,
        deviceId: input.externalPaymentDeviceId,
        digitalSaleIntentId: Number(winner.id),
      }, actor);
    }
    return {
      intentId: Number(winner.id),
      replay: true,
      expiresAt: winner.expiresAt,
    };
  }
  if (input.paymentMethod === "CARD") {
    await lockConfirmedExternalPaymentAttempt(tx, {
      branchId: input.branchId,
      channel: "POS",
      method: "CARD",
      amount: expectedTotal,
      attemptId: input.externalPaymentAttemptId,
      deviceId: input.externalPaymentDeviceId,
      digitalSaleIntentId: intentId,
    }, actor);
  }
  await reserveIntentInventory(tx, {
    intentId,
    branchId: input.branchId,
    snapshot: checkoutSnapshot,
  });

  for (const walletId of walletIds) {
    const [wallet] = await tx
      .select({
        id: digitalWallets.id,
        name: digitalWallets.name,
        isActive: digitalWallets.isActive,
        currentBalance: digitalWallets.currentBalance,
        reservedBalance: digitalWallets.reservedBalance,
        providerId: digitalWallets.providerId,
        branchId: digitalWallets.branchId,
      })
      .from(digitalWallets)
      .where(eq(digitalWallets.id, walletId))
      .for("update");
    if (!wallet) throw new TRPCError({ code: "NOT_FOUND", message: "المحفظة غير موجودة" });
    const expectedProviderId = resolved.find((r) => r.walletId === walletId)?.providerId;
    if (expectedProviderId == null || Number(wallet.providerId) !== expectedProviderId || Number(wallet.branchId) !== input.branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `المحفظة «${wallet.name}» لا تطابق مزوّد البطاقة وفرعها`,
      });
    }
    if (!wallet.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `المحفظة «${wallet.name}» معطَّلة` });
    }

    const need = sumMoney(needByWallet.get(walletId)!);
    const available = money(wallet.currentBalance).minus(money(wallet.reservedBalance));
    if (available.lt(need)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `رصيد «${wallet.name}» لا يكفي: المتاح ${toDbMoney(available)} والمطلوب ${toDbMoney(need)}. ` +
          `أودِع رصيداً أو أزِل بعض الكروت.`,
      });
    }

    await tx.insert(digitalWalletReservations).values({
      walletId,
      intentId,
      amount: toDbMoney(need),
      status: "ACTIVE",
    });
    await tx
      .update(digitalWallets)
      .set({ reservedBalance: toDbMoney(money(wallet.reservedBalance).plus(need)) })
      .where(eq(digitalWallets.id, walletId));
  }

  try {
    const referenceOwners = new Map<string, number>();
    for (const r of resolved) {
      const providerBasketKey = r.line.providerBasketKey?.toLowerCase() ?? null;
      const referenceOwnerItemId = providerBasketKey == null ? null : referenceOwners.get(providerBasketKey) ?? null;
      const itemResult = await tx.insert(digitalSaleIntentItems).values({
        intentId,
        lineKey: r.line.lineKey,
        providerBasketKey,
        referenceOwnerItemId,
        offeringId: r.offeringId,
        providerId: r.providerId,
        priceVersionId: r.priceVersionId,
        sellPriceSnapshot: r.sellPrice,
        providerShareSnapshot: r.providerShare,
        marginSnapshot: r.margin,
        fulfillmentStatus: "PENDING",
        providerReference: r.providerReference,
        studentCustomerId: null,
        studentNameSnapshot: r.student?.studentName ?? null,
        studentPhoneSnapshot: r.student?.studentPhone ?? null,
        guardianPhoneSnapshot: r.student?.guardianPhone ?? null,
        studentAddressSnapshot: r.student?.address ?? null,
      });
      if (providerBasketKey != null && referenceOwnerItemId == null) {
        referenceOwners.set(providerBasketKey, extractInsertId(itemResult));
      }
    }
  } catch (e) {
    if (isDupProviderRef(e)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "رقم العملية أو الاشتراك محفوظ لبيع آخر لدى المزوّد نفسه — طابق الرقم قبل المتابعة",
      });
    }
    throw e;
  }

  await auditLog(tx, actor, "digitalCards.intent.prepared", intentId, {
    branchId: input.branchId,
    items: resolved.length,
    expectedTotal,
  });

  return { intentId, replay: false, expiresAt };
}

/* ────────── تسجيل التنفيذ الخارجيّ ────────── */

export type ExecutionStatus = "SUCCESS" | "FAILED" | "UNKNOWN";

type ExecutionClaimRow = {
  intentItemId: number;
  claimToken: string;
  claimedBy: number;
  claimedAt: Date | string;
  expiresAt: Date | string;
  providerIdempotencyKey: string;
  completedAt: Date | string | null;
  isActive: number | string;
};

export interface ClaimExecutionResult {
  intentItemId: number;
  intentItemIds: number[];
  claimToken: string;
  providerIdempotencyKey: string;
  expiresAt: Date;
  replay: boolean;
}

/**
 * Claims one provider operation: an explicit basket, or one legacy item.
 * Every member resolves to the same owner lease, including competing windows.
 */
export async function claimExecution(
  tx: Tx,
  input: { intentId: number; intentItemId: number; claimToken: string },
  actor: Actor,
): Promise<ClaimExecutionResult> {
  const intent = await lockIntent(tx, input.intentId);
  assertActorOwnsIntent(intent, actor);
  if (!ALLOWED_PAYMENT_METHODS.has(intent.paymentMethod)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر بدء إصدار الكرت",
        why: "النيّة التاريخية تحمل طريقة دفع غير مسموحة",
        doThis: "لا تُصدر الكرت؛ انقل العملية إلى المراجعة الإدارية لتسويتها",
      }),
    });
  }
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (!["PREPARED", "EXECUTING", "NEEDS_REVIEW"].includes(intent.status)) {
    throw new TRPCError({ code: "CONFLICT", message: "هذه العملية مغلقة ولا تقبل إصدار بطاقة جديدة" });
  }
  if (intent.status === "NEEDS_REVIEW" && !elevated) {
    throw new TRPCError({ code: "FORBIDDEN", message: "تحتاج هذه العملية إلى مراجعة المدير قبل إعادة الإصدار" });
  }
  const [issuanceShift] = await tx
    .select({
      id: shifts.id,
      branchId: shifts.branchId,
      userId: shifts.userId,
      status: shifts.status,
    })
    .from(shifts)
    .where(eq(shifts.id, Number(intent.shiftId)))
    .for("update")
    .limit(1);
  if (
    !issuanceShift ||
    issuanceShift.status !== "OPEN" ||
    Number(issuanceShift.branchId) !== Number(intent.branchId) ||
    (!elevated && Number(issuanceShift.userId) !== actor.userId)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر بدء إصدار الكرت",
        why: "وردية النيّة أُغلقت أو تغيّر فرعها أو مالكها",
        doThis: "لا تُصدر الكرت؛ افتح عملية جديدة في وردية صحيحة أو اطلب مراجعة إدارية",
      }),
    });
  }
  // هذه نقطة اللاعودة قبل لمس جهاز المزوّد. withTx يمسك بوابة الإقفال المالي
  // المشتركة، لذلك لا يستطيع إقفال الشهر العبور بين هذا الفحص والتزام المطالبة.
  // وبعد المطالبة يمنع lockPeriod الإقفال ما دامت النية غير محسومة.
  await assertPeriodOpen(tx, new Date());

  const { item, items } = await lockExecutionItems(tx, input.intentId, input.intentItemId);
  const intentItemId = Number(item.id);
  const intentItemIds = items.map((member) => Number(member.id));
  await assertOfferingsIssuable(
    tx,
    Number(intent.branchId),
    items.map((member) => Number(member.offeringId)),
  );
  await intentInventoryExemptions(
    tx,
    input.intentId,
    intent.checkoutSnapshot,
  );
  if (items.some((member) => member.fulfillmentStatus === "SUCCESS")) {
    throw new TRPCError({ code: "CONFLICT", message: "هذه البطاقة صدرت وسُجلت بنجاح بالفعل" });
  }
  if (items.some((member) => member.fulfillmentStatus !== "PENDING") && !elevated) {
    throw new TRPCError({ code: "FORBIDDEN", message: "إعادة محاولة هذه البطاقة تحتاج إلى مراجعة المدير" });
  }

  const now = new Date();
  if (intent.expiresAt.getTime() <= now.getTime()) {
    throw new TRPCError({ code: "CONFLICT", message: "انتهت مهلة عملية البيع؛ ابدأ عملية جديدة أو راجع المدير" });
  }
  const claim = await lockExecutionClaim(tx, intentItemId);
  if (claim && claim.completedAt == null) {
    if (claim.claimToken === input.claimToken && Number(claim.claimedBy) === actor.userId) {
      return {
        intentItemId: Number(claim.intentItemId),
        intentItemIds,
        claimToken: claim.claimToken,
        providerIdempotencyKey: claim.providerIdempotencyKey,
        expiresAt: asDate(claim.expiresAt),
        replay: true,
      };
    }
    throw new TRPCError({
      code: "CONFLICT",
      message: "هذه البطاقة قيد الإصدار في نافذة أخرى؛ لا تُصدرها مرة ثانية",
    });
  }
  if (claim?.completedAt != null && item.fulfillmentStatus !== "PENDING" && !elevated) {
    throw new TRPCError({ code: "CONFLICT", message: "نتيجة هذه البطاقة مسجلة؛ لا تبدأ إصداراً جديداً" });
  }

  const expiresAt = new Date(now.getTime() + EXECUTION_CLAIM_TTL_MINUTES * 60_000);
  const providerIdempotencyKey = claim?.providerIdempotencyKey ?? `digital-issue:${input.intentId}:${intentItemId}`;
  try {
    if (claim) {
      await tx.execute(sql`
        UPDATE digitalSaleExecutionClaims
        SET claimToken = ${input.claimToken}, claimedBy = ${actor.userId}, claimedAt = ${now},
            expiresAt = ${expiresAt}, completedAt = NULL
        WHERE intentItemId = ${intentItemId}
      `);
    } else {
      await tx.execute(sql`
        INSERT INTO digitalSaleExecutionClaims
          (intentItemId, claimToken, claimedBy, claimedAt, expiresAt, providerIdempotencyKey, completedAt)
        VALUES
          (${intentItemId}, ${input.claimToken}, ${actor.userId}, ${now}, ${expiresAt}, ${providerIdempotencyKey}, NULL)
      `);
    }
  } catch (e) {
    if (isDuplicateEntry(e)) {
      throw new TRPCError({ code: "CONFLICT", message: "رمز بدء الإصدار مستخدم في نافذة أخرى؛ أعد المحاولة" });
    }
    throw e;
  }

  if (intent.status === "PREPARED") {
    await tx.update(digitalSaleIntents).set({ status: "EXECUTING" }).where(eq(digitalSaleIntents.id, input.intentId));
  }
  await auditLog(tx, actor, "digitalCards.intent.executionClaimed", input.intentId, {
    itemId: intentItemId,
    itemIds: intentItemIds,
    providerIdempotencyKey,
    expiresAt,
  });
  return { intentItemId, intentItemIds, claimToken: input.claimToken, providerIdempotencyKey, expiresAt, replay: false };
}

export async function markExecution(
  tx: Tx,
  input: { intentId: number; intentItemId: number; claimToken: string; status: ExecutionStatus; providerReference?: string | null },
  actor: Actor,
): Promise<{ itemId: number; itemIds: number[]; status: ExecutionStatus; allSettled: boolean; idempotent: boolean }> {
  const intent = await lockIntent(tx, input.intentId);
  assertActorOwnsIntent(intent, actor);
  if (!ALLOWED_PAYMENT_METHODS.has(intent.paymentMethod)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذّر تسجيل نتيجة الإصدار",
        why: "النيّة التاريخية تحمل طريقة دفع غير مسموحة",
        doThis: "لا تسجّل إصداراً جديداً؛ عالج العملية من طابور المراجعة الإدارية",
      }),
    });
  }
  if (!["PREPARED", "EXECUTING", "EXECUTED", "NEEDS_REVIEW"].includes(intent.status)) {
    throw new TRPCError({ code: "CONFLICT", message: `Intent status ${intent.status} is final and cannot be edited` });
  }
  const elevated = actor.role === "admin" || actor.role === "manager";

  const { item, items } = await lockExecutionItems(tx, input.intentId, input.intentItemId);
  const intentItemId = Number(item.id);
  const itemIds = items.map((member) => Number(member.id));

  const capturedRef = normalizeDigitalSaleReference(item.providerReference);
  const submittedRef = normalizeDigitalSaleReference(input.providerReference);
  if (capturedRef && submittedRef && capturedRef !== submittedRef) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "رقم العملية تغيّر بعد حجز البيع — أوقف التنفيذ وطابق الرقم المحفوظ",
    });
  }
  const ref = capturedRef || submittedRef || null;
  const claim = await lockExecutionClaim(tx, intentItemId);
  if (!claim || claim.claimToken !== input.claimToken || Number(claim.claimedBy) !== actor.userId) {
    throw new TRPCError({ code: "CONFLICT", message: "ابدأ إصدار البطاقة من هذه النافذة قبل تسجيل النتيجة" });
  }

  // A completed claim can only replay its exact recorded result.
  if (claim.completedAt != null && items.every((member) => member.fulfillmentStatus === input.status && (member.providerReference ?? null) === ref)) {
    return { itemId: intentItemId, itemIds, status: input.status, allSettled: await allItemsSettled(tx, input.intentId), idempotent: true };
  }
  if (claim.completedAt != null) {
    throw new TRPCError({ code: "CONFLICT", message: "نتيجة مطالبة الإصدار هذه سُجلت بالفعل ولا يمكن تغييرها" });
  }
  // Expiry opens the lease to a new claimant; it does not invalidate the
  // current token by itself. Until a reclaim actually replaces the token, the
  // original window must still be able to record a card it may have issued.
  if (intent.status === "EXECUTED") {
    throw new TRPCError({ code: "CONFLICT", message: "نتيجة النيّة المنفذة نهائية؛ نجاح الكرت غير قابل للتغيير" });
  }

  // **لا رجوع عن النجاح من الكاشير**: الكرت صدر فعلاً؛ التصحيح قرارٌ إداريّ (عكسٌ موثَّق).
  if (items.some((member) => member.fulfillmentStatus === "SUCCESS")) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A successful issued card is immutable; finalize, write off, or reverse it",
    });
  }
  if (items.some((member) => member.fulfillmentStatus !== "PENDING") && !elevated) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Manager review is required to correct a recorded result" });
  }

  // الرقم مطلوب لكل بطاقة/اشتراك. سياسة المزوّد القديمة لا تعطل حفظ دليل البيع الداخلي.
  const [provider] = await tx
    .select({ referencePolicy: digitalProviders.referencePolicy, name: suppliers.name })
    .from(digitalProviders)
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .where(eq(digitalProviders.id, Number(item.providerId)))
    .limit(1);
  if (input.status === "SUCCESS" && !ref) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `أدخل رقم العملية أو الاشتراك لدى «${provider?.name ?? "المزوّد"}»` });
  }

  try {
    await tx
      .update(digitalSaleIntentItems)
      .set({
        fulfillmentStatus: input.status,
        providerReference: ref,
        confirmedBy: actor.userId,
        confirmedAt: new Date(),
      })
      .where(inArray(digitalSaleIntentItems.id, itemIds));
    await tx.execute(sql`
      UPDATE digitalSaleExecutionClaims
      SET completedAt = ${new Date()}
      WHERE intentItemId = ${intentItemId} AND claimToken = ${input.claimToken} AND completedAt IS NULL
    `);
  } catch (e) {
    // القيد الفريد `uq_dsii_provider_ref` (هجرة 0127). drizzle يغلّف خطأ السائق ⇒ نفكّ
    // سلسلة `cause` كما في `isDupUserId` بـemployeeService (نفس الاصطلاح).
    if (isDupProviderRef(e)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "رقم المرجع مسجَّل لكرتٍ آخر من هذا المزوّد — تحقّق من الرقم",
      });
    }
    throw e;
  }

  if (intent.status === "PREPARED") {
    await tx.update(digitalSaleIntents).set({ status: "EXECUTING" }).where(eq(digitalSaleIntents.id, input.intentId));
  }

  const allSettled = await allItemsSettled(tx, input.intentId);
  if (allSettled) {
    const anyFailed = await hasNonSuccess(tx, input.intentId);
    await tx
      .update(digitalSaleIntents)
      .set({ status: anyFailed ? "NEEDS_REVIEW" : "EXECUTED" })
      .where(eq(digitalSaleIntents.id, input.intentId));
  }

  await auditLog(tx, actor, "digitalCards.intent.execution", input.intentId, {
    itemId: intentItemId,
    itemIds,
    status: input.status,
    hasReference: ref != null,
  });

  return { itemId: intentItemId, itemIds, status: input.status, allSettled, idempotent: false };
}

/* ────────── الإلغاء والانتهاء ────────── */

/**
 * إلغاء نيّة **لم يُنفَّذ منها شيء**: يحرّر الحجوزات ويعيد الرصيد المحجوز.
 * وجودُ بندٍ ناجحٍ واحد يمنع الإلغاء ⇒ تنتقل إلى NEEDS_REVIEW بدلاً منه.
 */
export async function cancelIntent(
  tx: Tx,
  input: { intentId: number; reason?: string | null },
  actor: Actor,
): Promise<{ intentId: number; outcome: "CANCELLED" | "NEEDS_REVIEW" }> {
  const intent = await lockIntent(tx, input.intentId);
  assertActorOwnsIntent(intent, actor);
  if (intent.status === "CANCELLED") {
    return { intentId: input.intentId, outcome: "CANCELLED" };
  }
  if (!["PREPARED", "EXECUTING", "EXECUTED", "NEEDS_REVIEW"].includes(intent.status)) {
    throw new TRPCError({ code: "CONFLICT", message: `Intent status ${intent.status} is final and cannot be cancelled` });
  }

  const unsafe = await hasUnsafeExecution(tx, input.intentId);
  const hasConfirmedExternalPayment = intent.externalPaymentAttemptId != null;
  if (unsafe || hasConfirmedExternalPayment) {
    // الحجز **لا يُحرَّر**: كرتٌ صدر فعلاً وله أثرٌ ماليّ مستحقّ. المراجعة الإدارية تحسمه.
    await tx.update(digitalSaleIntents).set({ status: "NEEDS_REVIEW" }).where(eq(digitalSaleIntents.id, input.intentId));
    await auditLog(tx, actor, "digitalCards.intent.needsReview", input.intentId, {
      reason:
        input.reason ??
        (hasConfirmedExternalPayment
          ? "cancel-after-confirmed-external-payment"
          : "cancel-after-execution"),
    });
    return { intentId: input.intentId, outcome: "NEEDS_REVIEW" };
  }

  await deleteExecutionClaims(tx, input.intentId);
  await releaseReservations(tx, input.intentId);
  // لم يبدأ إصدار أي بطاقة؛ تحرير الرقم يسمح باستعماله في محاولة صحيحة لاحقة.
  await tx
    .update(digitalSaleIntentItems)
    .set({ providerReference: null })
    .where(eq(digitalSaleIntentItems.intentId, input.intentId));
  await tx.update(digitalSaleIntents).set({ status: "CANCELLED" }).where(eq(digitalSaleIntents.id, input.intentId));
  await auditLog(tx, actor, "digitalCards.intent.cancelled", input.intentId, { reason: input.reason ?? null });
  return { intentId: input.intentId, outcome: "CANCELLED" };
}

/**
 * كنّاس النيّات المنتهية: يحرّر حجوزات النيّات **الخالية من أي تنفيذ** ويجعلها EXPIRED،
 * ويحوّل ما نُفِّذ منها شيءٌ إلى NEEDS_REVIEW **دون تحرير حجزه** (§٥.٩).
 */
export async function expireStaleIntents(
  tx: Tx,
  now: Date = new Date(),
): Promise<{ expired: number; needsReview: number }> {
  // **EXECUTED مشمولةٌ عمداً:** نيّةٌ صدرت كل كروتها ثم هُجرت قبل تثبيت الفاتورة (أُغلق المتصفّح،
  // انقطعت الشبكة) هي أخطر الحالات — كروتٌ بيد الزبون بلا فاتورة. لا يجوز تركها معلّقةً للأبد.
  const stale = await tx
    .select({ id: digitalSaleIntents.id })
    .from(digitalSaleIntents)
    .where(
      and(
        inArray(digitalSaleIntents.status, ["PREPARED", "EXECUTING", "EXECUTED"]),
        lt(digitalSaleIntents.expiresAt, now),
      ),
    )
    .orderBy(asc(digitalSaleIntents.id))
    .limit(200);

  let expired = 0;
  let needsReview = 0;
  for (const s of stale) {
    const intentId = Number(s.id);
    const locked = await lockIntent(tx, intentId);
    if (
      !["PREPARED", "EXECUTING", "EXECUTED"].includes(locked.status) ||
      locked.expiresAt.getTime() >= now.getTime()
    ) {
      continue;
    }
    if (
      locked.externalPaymentAttemptId != null ||
      await hasUnsafeExecution(tx, intentId)
    ) {
      await tx.update(digitalSaleIntents).set({ status: "NEEDS_REVIEW" }).where(eq(digitalSaleIntents.id, intentId));
      needsReview++;
    } else {
      await deleteExecutionClaims(tx, intentId);
      await releaseReservations(tx, intentId);
      await tx
        .update(digitalSaleIntentItems)
        .set({ providerReference: null })
        .where(eq(digitalSaleIntentItems.intentId, intentId));
      await tx.update(digitalSaleIntents).set({ status: "EXPIRED" }).where(eq(digitalSaleIntents.id, intentId));
      expired++;
    }
  }
  return { expired, needsReview };
}

/* ────────── قراءات ────────── */

export async function getIntent(db: DB, intentId: number) {
  const [intent] = await db.select().from(digitalSaleIntents).where(eq(digitalSaleIntents.id, intentId)).limit(1);
  if (!intent) return null;

  const items = await db
    .select({
      id: digitalSaleIntentItems.id,
      lineKey: digitalSaleIntentItems.lineKey,
      providerBasketKey: digitalSaleIntentItems.providerBasketKey,
      referenceOwnerItemId: digitalSaleIntentItems.referenceOwnerItemId,
      offeringId: digitalSaleIntentItems.offeringId,
      variantId: digitalOfferings.variantId,
      productUnitId: digitalOfferings.productUnitId,
      offeringType: digitalOfferings.offeringType,
      name: products.name,
      providerName: suppliers.name,
      referencePolicy: digitalProviders.referencePolicy,
      sellPrice: digitalSaleIntentItems.sellPriceSnapshot,
      fulfillmentStatus: digitalSaleIntentItems.fulfillmentStatus,
      providerReference: digitalSaleIntentItems.providerReference,
      studentName: digitalSaleIntentItems.studentNameSnapshot,
      confirmedAt: digitalSaleIntentItems.confirmedAt,
    })
    .from(digitalSaleIntentItems)
    .innerJoin(digitalOfferings, eq(digitalSaleIntentItems.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(digitalProviders, eq(digitalSaleIntentItems.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .where(eq(digitalSaleIntentItems.intentId, intentId))
    .orderBy(asc(digitalSaleIntentItems.id));

  let netByLineKey: Map<string, string> | null = null;
  const checkout = intent.checkoutSnapshot ?? null;
  if (checkout?.sourceType === "INVOICE") {
    const payload = parseInvoiceSourcePayload(checkout.sourcePayload);
    netByLineKey = computeInvoiceIntentTotal({
      regularSubtotal: checkout.expectedSubtotal,
      sourcePayload: payload,
      digitalLines: items.map((item) => ({
        lineKey: item.lineKey,
        variantId: Number(item.variantId),
        productUnitId: Number(item.productUnitId),
        sellPrice: item.sellPrice,
      })),
    }).digitalLineTotals;
  }

  return {
    intent,
    items: items.map(({ variantId: _variantId, productUnitId: _productUnitId, ...item }) => ({
      ...item,
      /** المبلغ الفعلي المحصّل لهذا السطر؛ سعر القائمة وحده يضلّل عند خصم السطر. */
      chargeAmount: netByLineKey?.get(item.lineKey) ?? item.sellPrice,
    })),
  };
}

/**
 * طابور المراجعة: نيّات فيها كرتٌ صدر ولم تُثبَّت بفاتورة — لا تُترك بلا معالجة.
 * يشمل `WRITEOFF_PENDING` (هجرة 0129) كي يرى المعتمِد الطلبات المعلّقة في الطابور نفسه؛
 * لو أُخفيت لاختفى الطلبُ عن كل شاشة وبقي الحجز مجمَّداً بلا أثرٍ مرئيّ.
 */
export async function listNeedsReview(db: DB, filters: { branchId?: number | null }) {
  const conds = [inArray(digitalSaleIntents.status, ["NEEDS_REVIEW", "WRITEOFF_PENDING"] as const)];
  if (filters.branchId != null) conds.push(eq(digitalSaleIntents.branchId, filters.branchId));

  return db
    .select({
      id: digitalSaleIntents.id,
      branchId: digitalSaleIntents.branchId,
      branchName: branches.name,
      createdBy: digitalSaleIntents.createdBy,
      createdByName: users.name,
      createdByUsername: users.username,
      shiftId: digitalSaleIntents.shiftId,
      shiftStatus: shifts.status,
      shiftOpenedAt: shifts.openedAt,
      shiftClosedAt: shifts.closedAt,
      paymentMethod: digitalSaleIntents.paymentMethod,
      expectedTotal: digitalSaleIntents.expectedTotal,
      createdAt: digitalSaleIntents.createdAt,
      expiresAt: digitalSaleIntents.expiresAt,
      status: digitalSaleIntents.status,
      writeoffRequestedBy: digitalSaleIntents.writeoffRequestedBy,
      writeoffReason: digitalSaleIntents.writeoffReason,
      resolutionDecision: sql<string | null>`(
        SELECT r.decision FROM digitalSaleReviewResolutions r
        WHERE r.intentId = digitalSaleIntents.id LIMIT 1
      )`,
      resolutionStatus: sql<string | null>`(
        SELECT r.status FROM digitalSaleReviewResolutions r
        WHERE r.intentId = digitalSaleIntents.id LIMIT 1
      )`,
      resolutionReason: sql<string | null>`(
        SELECT r.reason FROM digitalSaleReviewResolutions r
        WHERE r.intentId = digitalSaleIntents.id LIMIT 1
      )`,
      resolutionRequestedBy: sql<number | null>`(
        SELECT r.requestedBy FROM digitalSaleReviewResolutions r
        WHERE r.intentId = digitalSaleIntents.id LIMIT 1
      )`,
      successCount: sql<number>`(
        SELECT COUNT(*) FROM digitalSaleIntentItems i
        WHERE i.intentId = digitalSaleIntents.id AND i.fulfillmentStatus = 'SUCCESS'
      )`,
      pendingCount: sql<number>`(
        SELECT COUNT(*) FROM digitalSaleIntentItems i
        WHERE i.intentId = digitalSaleIntents.id AND i.fulfillmentStatus = 'PENDING'
      )`,
      failedCount: sql<number>`(
        SELECT COUNT(*) FROM digitalSaleIntentItems i
        WHERE i.intentId = digitalSaleIntents.id AND i.fulfillmentStatus = 'FAILED'
      )`,
      unknownCount: sql<number>`(
        SELECT COUNT(*) FROM digitalSaleIntentItems i
        WHERE i.intentId = digitalSaleIntents.id AND i.fulfillmentStatus = 'UNKNOWN'
      )`,
      referenceCount: sql<number>`(
        SELECT COUNT(*) FROM digitalSaleIntentItems i
        WHERE i.intentId = digitalSaleIntents.id AND i.providerReference IS NOT NULL
      )`,
      openClaimCount: sql<number>`(
        SELECT COUNT(*)
        FROM digitalSaleExecutionClaims c
        INNER JOIN digitalSaleIntentItems i ON i.id = c.intentItemId
        WHERE i.intentId = digitalSaleIntents.id AND c.completedAt IS NULL
      )`,
      activeClaimCount: sql<number>`(
        SELECT COUNT(*)
        FROM digitalSaleExecutionClaims c
        INNER JOIN digitalSaleIntentItems i ON i.id = c.intentItemId
        WHERE i.intentId = digitalSaleIntents.id
          AND c.completedAt IS NULL
          AND c.expiresAt > CURRENT_TIMESTAMP(3)
      )`,
      /**
       * المحجوز فعلاً = مجموع حصص المزوّد النشطة، **لا** `expectedTotal` (سعر البيع).
       * الفرق بينهما هو الهامش؛ عرضُ سعر البيع مكان المحجوز يوهم المدير بأن الإلغاء
       * يعيد مبلغاً أكبر ممّا يعيده فعلاً (جولة بصرية ٣٠/٧).
       */
      reservedAmount: sql<string>`COALESCE((
        SELECT SUM(r.amount) FROM digitalWalletReservations r
        WHERE r.intentId = digitalSaleIntents.id AND r.status = 'ACTIVE'
      ), 0)`,
      itemCount: sql<number>`(
        SELECT COUNT(*) FROM digitalSaleIntentItems i WHERE i.intentId = digitalSaleIntents.id
      )`,
    })
    .from(digitalSaleIntents)
    .innerJoin(branches, eq(digitalSaleIntents.branchId, branches.id))
    .innerJoin(shifts, eq(digitalSaleIntents.shiftId, shifts.id))
    .leftJoin(users, eq(digitalSaleIntents.createdBy, users.id))
    .where(and(...conds))
    .orderBy(asc(digitalSaleIntents.id))
    .limit(200);
}

/* ────────── مساعدات داخلية ────────── */

/** Never trust a caller-supplied fingerprint to identify the captured digital contents. */
function digitalCartFingerprint(input: PrepareInput): string {
  return createHash("sha256").update(JSON.stringify({
    fingerprint: input.cartFingerprint,
    lines: input.lines.map((line) => ({
      lineKey: line.lineKey,
      offeringId: line.offeringId,
      priceVersionId: line.priceVersionId,
      expectedSellPrice: toDbMoney(money(line.expectedSellPrice)),
      providerReference: normalizeDigitalSaleReference(line.providerReference),
      providerBasketKey: line.providerBasketKey?.toLowerCase() ?? null,
      student: line.student ? normalizeSaleStudent(line.student) : null,
    })),
  })).digest("hex");
}

/** آخر بوابة قبل لمس جهاز المزوّد؛ لقطة prepare لا تكفي إذا عُطّل الكتالوج بعدها. */
async function assertOfferingsIssuable(
  tx: Tx,
  branchId: number,
  offeringIds: number[],
): Promise<void> {
  const ids = Array.from(new Set(offeringIds)).sort((a, b) => a - b);
  const rows = await tx
    .select({
      offeringId: digitalOfferings.id,
      name: products.name,
      offeringActive: digitalOfferings.isActive,
      providerActive: digitalProviders.isActive,
      assignmentActive: digitalOfferingBranches.isActive,
      branchActive: branches.isActive,
      productType: products.productType,
      productActive: products.isActive,
      productIsService: products.isService,
      productIsBundle: products.isBundle,
      productIsConsignment: products.isConsignment,
      variantActive: productVariants.isActive,
      unitActive: productUnits.isActive,
      unitIsBase: productUnits.isBaseUnit,
    })
    .from(digitalOfferings)
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(
      productVariants,
      and(
        eq(digitalOfferings.variantId, productVariants.id),
        eq(productVariants.productId, products.id),
      ),
    )
    .innerJoin(
      productUnits,
      and(
        eq(digitalOfferings.productUnitId, productUnits.id),
        eq(productUnits.variantId, productVariants.id),
      ),
    )
    .innerJoin(digitalProviders, eq(digitalOfferings.providerId, digitalProviders.id))
    .innerJoin(
      digitalOfferingBranches,
      and(
        eq(digitalOfferingBranches.offeringId, digitalOfferings.id),
        eq(digitalOfferingBranches.branchId, branchId),
      ),
    )
    .innerJoin(branches, eq(digitalOfferingBranches.branchId, branches.id))
    .where(inArray(digitalOfferings.id, ids));
  const byId = new Map(rows.map((row) => [Number(row.offeringId), row]));
  for (const offeringId of ids) {
    const row = byId.get(offeringId);
    if (!row) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذّر تثبيت ربط البطاقة",
          why: "حُذف عرض رقمي أو تغيّر ربطه بعد تجهيز السلة",
          doThis: "لا تُصدر من جهاز المزوّد؛ حدّث العملية وأعد إضافة البطاقة",
        }),
      });
    }
    if (
      row.offeringActive !== true ||
      row.providerActive !== true ||
      row.assignmentActive !== true ||
      row.branchActive !== true ||
      row.productActive !== true ||
      row.variantActive !== true ||
      row.unitActive !== true ||
      row.unitIsBase !== true ||
      row.productType !== "DIGITAL_CARD" ||
      row.productIsService !== true ||
      row.productIsBundle === true ||
      row.productIsConsignment === true
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر إصدار «${row.name}»`,
          why: "العرض أو مزوّده أو فرعه أو ربطه المخزني معطّل أو لم يعد بطاقة رقمية صالحة",
          doThis: "لا تُصدرها من جهاز المزوّد؛ أصلح الربط ثم أنشئ سلة جديدة",
        }),
      });
    }
  }
}

/** The intent lock serializes the whole provider operation, including calls through a member. */
async function lockExecutionItems(tx: Tx, intentId: number, intentItemId: number) {
  const all = await tx.select().from(digitalSaleIntentItems)
    .where(eq(digitalSaleIntentItems.intentId, intentId))
    .orderBy(asc(digitalSaleIntentItems.id)).for("update");
  const selected = all.find((row) => Number(row.id) === intentItemId);
  if (!selected) throw new TRPCError({ code: "NOT_FOUND", message: appErrorMessage({ what: "بند التنفيذ غير موجود", why: "البند لا يتبع هذه العملية", doThis: "حدّث عملية البيع" }) });
  if (selected.providerBasketKey == null) return { item: selected, items: [selected] };
  const items = all.filter((row) => row.providerBasketKey === selected.providerBasketKey);
  const owners = items.filter((row) => row.referenceOwnerItemId == null);
  const item = owners[0];
  if (owners.length !== 1 || items.some((row) =>
    row.providerId !== item.providerId ||
    (row.id !== item.id && row.referenceOwnerItemId !== item.id) ||
    (row.providerReference != null && normalizeDigitalSaleReference(row.providerReference) !== normalizeDigitalSaleReference(item.providerReference))
  )) {
    throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({ what: "تعذّر تنفيذ السلة", why: "ارتباط بنود عملية المزوّد غير متسق", doThis: "أوقف الإصدار وراجع المدير" }) });
  }
  return { item, items };
}

/** هل الخطأ تكرارٌ على قيد مرجع المزوّد؟ (نمط `isDupUserId` في employeeService — فكّ سلسلة cause.) */
function isDupProviderRef(e: unknown): boolean {
  const err = e as { code?: string; sqlMessage?: string; message?: string; cause?: unknown };
  const code =
    err?.code ??
    (err?.cause as { code?: string } | undefined)?.code ??
    ((err?.cause as { cause?: { code?: string } } | undefined)?.cause)?.code;
  if (code !== "ER_DUP_ENTRY") return false;
  const msg = String(
    err?.sqlMessage ??
      (err?.cause as { sqlMessage?: string } | undefined)?.sqlMessage ??
      err?.message ??
      "",
  );
  return /uq_dsii_provider_ref|refKey/i.test(msg);
}

function isDuplicateEntry(e: unknown): boolean {
  const err = e as { code?: string; cause?: unknown };
  return (
    err?.code === "ER_DUP_ENTRY" ||
    (err?.cause as { code?: string } | undefined)?.code === "ER_DUP_ENTRY" ||
    ((err?.cause as { cause?: { code?: string } } | undefined)?.cause)?.code === "ER_DUP_ENTRY"
  );
}

function rowsOf(result: unknown): any[] {
  if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function lockExecutionClaim(tx: Tx, intentItemId: number): Promise<ExecutionClaimRow | null> {
  const result = await tx.execute(sql`
    SELECT intentItemId, claimToken, claimedBy, claimedAt, expiresAt, providerIdempotencyKey, completedAt,
           (expiresAt > CURRENT_TIMESTAMP(3)) AS isActive
    FROM digitalSaleExecutionClaims
    WHERE intentItemId = ${intentItemId}
    FOR UPDATE
  `);
  return (rowsOf(result)[0] as ExecutionClaimRow | undefined) ?? null;
}

/** SUCCESS/UNKNOWN or an uncompleted provider lease means money must stay reserved for review. */
async function hasUnsafeExecution(tx: Tx, intentId: number): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT COUNT(*) AS n
    FROM digitalSaleIntentItems i
    LEFT JOIN digitalSaleExecutionClaims c ON c.intentItemId = i.id
    WHERE i.intentId = ${intentId}
      AND (i.fulfillmentStatus IN ('SUCCESS', 'UNKNOWN') OR (c.intentItemId IS NOT NULL AND c.completedAt IS NULL))
  `);
  return Number(rowsOf(result)[0]?.n ?? 0) > 0;
}

async function deleteExecutionClaims(tx: Tx, intentId: number): Promise<void> {
  await tx.execute(sql`
    DELETE c FROM digitalSaleExecutionClaims c
    INNER JOIN digitalSaleIntentItems i ON i.id = c.intentItemId
    WHERE i.intentId = ${intentId}
  `);
}

async function lockIntent(tx: Tx, intentId: number) {
  const [intent] = await tx.select().from(digitalSaleIntents).where(eq(digitalSaleIntents.id, intentId)).for("update");
  if (!intent) throw new TRPCError({ code: "NOT_FOUND", message: "النيّة غير موجودة" });
  return intent;
}

export function assertActorOwnsIntent(intent: { createdBy: number; branchId: number }, actor: Actor): void {
  // المشرف (المالك/الأدمن/المدير) يرى نيّات موظّفي نطاقه لا ما أنشأه هو فقط (عزل السجلّ الفرديّ للكاشير).
  const supervisor = actor.role === "admin" || actor.role === "manager";
  if (!supervisor && Number(intent.createdBy) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه النيّة لمستخدم آخر" });
  }
  // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران الفروع (owner مُطبَّع ⇒ admin)؛
  // المدير مقيَّدٌ بفرعه — كان `|| manager` يُعفيه فيمسّ نيّة فرعٍ آخر.
  if (actor.role !== "admin" && Number(intent.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه النيّة تخص فرعاً آخر" });
  }
}

async function allItemsSettled(tx: Tx, intentId: number): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(digitalSaleIntentItems)
    .where(and(eq(digitalSaleIntentItems.intentId, intentId), eq(digitalSaleIntentItems.fulfillmentStatus, "PENDING")));
  return Number(row?.n ?? 0) === 0;
}

async function hasNonSuccess(tx: Tx, intentId: number): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(digitalSaleIntentItems)
    .where(and(eq(digitalSaleIntentItems.intentId, intentId), ne(digitalSaleIntentItems.fulfillmentStatus, "SUCCESS")));
  return Number(row?.n ?? 0) > 0;
}

async function hasSuccessfulItem(tx: Tx, intentId: number): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(digitalSaleIntentItems)
    .where(and(eq(digitalSaleIntentItems.intentId, intentId), eq(digitalSaleIntentItems.fulfillmentStatus, "SUCCESS")));
  return Number(row?.n ?? 0) > 0;
}

/** يحرّر كل الحجوزات الفعّالة لنيّة ويعيد المبالغ إلى `reservedBalance` — بترتيب walletId. */
async function releaseReservations(tx: Tx, intentId: number): Promise<void> {
  const active = await tx
    .select({ id: digitalWalletReservations.id, walletId: digitalWalletReservations.walletId, amount: digitalWalletReservations.amount })
    .from(digitalWalletReservations)
    .where(and(eq(digitalWalletReservations.intentId, intentId), eq(digitalWalletReservations.status, "ACTIVE")))
    .orderBy(asc(digitalWalletReservations.walletId));

  for (const r of active) {
    const [wallet] = await tx
      .select({ reservedBalance: digitalWallets.reservedBalance })
      .from(digitalWallets)
      .where(eq(digitalWallets.id, Number(r.walletId)))
      .for("update");
    if (!wallet) continue;
    // القصّ عند الصفر: حارسٌ ضد رصيدٍ محجوزٍ سالبٍ لو تسلّل تحريرٌ مزدوج.
    const next = money(wallet.reservedBalance).minus(money(r.amount));
    await tx
      .update(digitalWallets)
      .set({ reservedBalance: toDbMoney(next.lt(0) ? money(0) : next) })
      .where(eq(digitalWallets.id, Number(r.walletId)));
    await tx
      .update(digitalWalletReservations)
      .set({ status: "RELEASED", releasedAt: new Date() })
      .where(and(eq(digitalWalletReservations.id, Number(r.id)), eq(digitalWalletReservations.status, "ACTIVE")));
  }
  await releaseIntentInventory(tx, intentId);
}

/** يُستعمل في اختبارات الاتساق: مجموع الحجوزات الفعّالة لمحفظة. */
export async function activeReservedTotal(db: DB, walletId: number): Promise<string> {
  const rows = await db
    .select({ amount: digitalWalletReservations.amount })
    .from(digitalWalletReservations)
    .where(and(eq(digitalWalletReservations.walletId, walletId), eq(digitalWalletReservations.status, "ACTIVE")));
  return toDbMoney(sumMoney(rows.map((r) => r.amount)));
}

export const INTENT_TTL = INTENT_TTL_MINUTES;
export const EXECUTION_CLAIM_TTL = EXECUTION_CLAIM_TTL_MINUTES;
