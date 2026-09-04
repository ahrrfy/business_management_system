import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import {
  customers,
  invoices,
  receipts,
  productUnits,
  productVariants,
  products,
  quotationItems,
  quotations,
} from "../../drizzle/schema";
import type { Tx } from "../db";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { computeInvoiceTotals, computeLineTotal } from "./billing";
import { localDayStart, localNextDayStart } from "./dateRange";
import { convertToBaseQuantity } from "./inventoryService";
import { money, round2, toDateStr } from "./money";
import { getUnitPrice, resolveTier, type PriceTier } from "./pricing";
import { createSaleInTx, notifySaleCustomerAfterCommit } from "./sale/create";
import { openShiftIdTx } from "./shiftService";
import {
  checkIdempotency,
  findIdempotentRefId,
  idempotencyHash,
  recordIdempotencyKey,
} from "./idempotency";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { assertPosPaymentMethodEnabled } from "./posPaymentPolicy";
import {
  assertExternalPaymentReplay,
  consumeConfirmedExternalPaymentAttemptTx,
} from "./posExternalPayment";

type PaymentMethod = "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";

export interface QuotationLineInput {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
}

export interface CreateQuotationInput {
  branchId: number;
  customerId?: number | null;
  priceTier?: PriceTier | null;
  validUntil?: string | null; // YYYY-MM-DD
  lines: QuotationLineInput[];
  invoiceDiscount?: string | null;
  taxRatePercent?: string | null;
  notes?: string | null;
  /** idempotency (F3): نفس المفتاح يُعيد عرض الإنشاء الأول (النقر المزدوج لا يُنشئ عرضين). */
  clientRequestId?: string | null;
}

export interface UpdateQuotationInput extends Omit<CreateQuotationInput, "branchId" | "clientRequestId"> {
  quotationId: number;
}

async function nextQuoteNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `QUO-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: quotations.quoteNumber })
    .from(quotations)
    .where(like(quotations.quoteNumber, `${prefix}%`))
    .orderBy(desc(quotations.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

/** يُنشئ عرض سعر — مستند فقط، بلا أي أثر على المخزون أو الدفتر. */
export async function createQuotation(input: CreateQuotationInput, actor: Actor,
) {
  return withTx(async (tx) => {
    if (!input.lines.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن حفظ عرض السعر",
          why: "قائمة الأصناف فارغة — عرض السعر يلزمه بند واحد على الأقل",
          doThis: "أضف صنفاً واحداً على الأقل من زر «إضافة بند» ثم أعد الحفظ",
        }),
      });

    // idempotency (F3): طلبٌ بنفس المفتاح يُعيد عرض الإنشاء الأول بلا إنشاء مكرّر. القيد الفريد
    // على (operation, key) يمنع سباق طلبَين متزامنين (الثاني يتلقّى ER_DUP_ENTRY فيُعيد الراوتر
    // المحاولة عبر retryOnDup ⇒ يجد المفتاح هنا فيُعيد الأول).
    if (input.clientRequestId) {
      const existingId = await findIdempotentRefId(tx, "quotation.create", input.clientRequestId,
      );
      if (existingId != null) {
        const prev = (
          await tx
            .select({ quoteNumber: quotations.quoteNumber, total: quotations.total,
            })
            .from(quotations)
            .where(eq(quotations.id, existingId))
            .limit(1)
        )[0];
        return {
          quotationId: existingId,
          quoteNumber: prev?.quoteNumber ?? "",
          total: prev?.total ?? "0",
          idempotentReplay: true as const,
        };
      }
    }

    // فئة السعر من العميل أو التجاوز اليدوي.
    let customerTier: PriceTier | null = null;
    if (input.customerId) {
      const c = await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
      if (!c[0])
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تسجيل عرض السعر",
            why: "العميل المرسل غير موجود (قد يكون حُذف أو دُمج)",
            doThis: "أعد اختيار العميل من قائمة العملاء، أو أنشئه من شاشة العملاء أوّلاً",
          }),
        });
      customerTier = c[0].defaultPriceTier as PriceTier;
    }
    const tier = resolveTier({ override: input.priceTier ?? null, customerTier,
    });

    const computed = [];
    for (const l of input.lines) {
      const { baseQuantity } = await convertToBaseQuantity(tx, l.productUnitId, l.quantity, l.variantId,
      );
      const unitPrice =
        l.unitPriceOverride != null && l.unitPriceOverride !== ""
          ? money(l.unitPriceOverride)
          : await getUnitPrice(tx, l.productUnitId, tier);
      const lineRes = computeLineTotal({
        unitPrice,
        quantity: money(l.quantity),
        discountPercent: l.discountPercent,
        discountAmount: l.discountAmount,
      });
      computed.push({
        variantId: l.variantId,
        productUnitId: l.productUnitId,
        baseQuantity,
        unitPrice: lineRes.unitPrice,
        quantity: lineRes.quantity,
        discountAmount: lineRes.discountAmount,
        total: lineRes.total,
      });
    }

    const totals = computeInvoiceTotals({
      lineTotals: computed.map((c) => c.total),
      invoiceDiscount: input.invoiceDiscount,
      taxRatePercent: input.taxRatePercent,
    });

    const quoteNumber = await nextQuoteNumber(tx, input.branchId);
    const insRes = await tx.insert(quotations).values({
      quoteNumber,
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      priceTier: tier,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      taxRatePercent: round2(money(input.taxRatePercent ?? "0")).toFixed(2),
      discountAmount: totals.discountAmount,
      total: totals.total,
      status: "DRAFT",
      notes: input.notes ?? null,
      createdBy: actor.userId,
    });
    const quotationId = extractInsertId(insRes);

    for (const c of computed) {
      await tx.insert(quotationItems).values({
        quotationId,
        variantId: c.variantId,
        productUnitId: c.productUnitId,
        quantity: c.quantity,
        baseQuantity: c.baseQuantity,
        unitPrice: c.unitPrice,
        discountAmount: c.discountAmount,
        total: c.total,
      });
    }
    // سجّل مفتاح الـidempotency بعد نجاح الكتابة (refId = معرّف العرض).
    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "quotation.create", input.clientRequestId, quotationId,
      );
    }
    return { quotationId, quoteNumber, total: totals.total };
  });
}

/** يعدّل مسودة عرض سعر ذرّياً. العروض المرسلة/المقبولة تبقى لقطة التزام لا تُطمس. */
export async function updateQuotation(input: UpdateQuotationInput, actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    if (!input.lines.length)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن حفظ عرض السعر",
          why: "قائمة الأصناف فارغة — عرض السعر يلزمه بند واحد على الأقل",
          doThis: "أضف صنفاً واحداً على الأقل من زر «إضافة بند» ثم أعد الحفظ",
        }),
      });

    const current = (
      await tx.select().from(quotations).where(eq(quotations.id, input.quotationId)).for("update").limit(1)
    )[0];
    if (!current)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر العثور على عرض السعر",
          why: "الرقم المرسل يشير إلى عرض محذوف أو غير موجود",
          doThis: "أعد تحميل قائمة عروض الأسعار — العرض قد يكون حُذف أو تغيّر رقمه",
        }),
      });
    assertQuotationBranchStrict(current, actor);
    if (current.status !== "DRAFT") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن تعديل هذا العرض",
          why: `العرض غادر حالة المسوّدة (الحالة حالياً «${current.status}») — التعديل بعد إرساله يفسد لقطة الالتزام المرسلة للعميل`,
          doThis: "أنشئ نسخة جديدة من العرض بزر «نسخ لعرض جديد» ثم عدّل النسخة",
        }),
      });
    }

    let customerTier: PriceTier | null = null;
    if (input.customerId) {
      const customer = (await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
      if (!customer)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تعديل عرض السعر",
            why: "العميل المرسل غير موجود (قد يكون حُذف أو دُمج بعد إنشاء العرض)",
            doThis: "أعد اختيار العميل من قائمة العملاء، أو أنشئه من شاشة العملاء أوّلاً",
          }),
        });
      customerTier = customer.defaultPriceTier as PriceTier;
    }
    const tier = resolveTier({ override: input.priceTier ?? null, customerTier,
    });

    const computed: Array<{
      variantId: number;
      productUnitId: number;
      baseQuantity: number;
      unitPrice: string;
      quantity: string;
      discountAmount: string;
      total: string;
    }> = [];
    for (const line of input.lines) {
      const { baseQuantity } = await convertToBaseQuantity(
        tx,
        line.productUnitId,
        line.quantity,
        line.variantId,
      );
      const unitPrice =
        line.unitPriceOverride != null && line.unitPriceOverride !== ""
          ? money(line.unitPriceOverride)
          : await getUnitPrice(tx, line.productUnitId, tier);
      const result = computeLineTotal({
        unitPrice,
        quantity: money(line.quantity),
        discountPercent: line.discountPercent,
        discountAmount: line.discountAmount,
      });
      computed.push({
        variantId: line.variantId,
        productUnitId: line.productUnitId,
        baseQuantity,
        unitPrice: result.unitPrice,
        quantity: result.quantity,
        discountAmount: result.discountAmount,
        total: result.total,
      });
    }

    const totals = computeInvoiceTotals({
      lineTotals: computed.map((line) => line.total),
      invoiceDiscount: input.invoiceDiscount,
      taxRatePercent: input.taxRatePercent,
    });

    await tx
      .update(quotations)
      .set({
        customerId: input.customerId ?? null,
        priceTier: tier,
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        taxRatePercent: round2(money(input.taxRatePercent ?? "0")).toFixed(2),
        discountAmount: totals.discountAmount,
        total: totals.total,
        notes: input.notes ?? null,
      })
      .where(eq(quotations.id, input.quotationId));

    await tx.delete(quotationItems).where(eq(quotationItems.quotationId, input.quotationId));
    await tx.insert(quotationItems).values(
      computed.map((line) => ({
        quotationId: input.quotationId,
        ...line,
      })),
    );

    return {
      quotationId: input.quotationId,
      quoteNumber: current.quoteNumber,
      total: totals.total,
    };
  });
}

type QuoteStatus =
  | "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "CONVERTED" | "EXPIRED";

const ALLOWED_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  DRAFT: ["SENT", "ACCEPTED", "REJECTED", "EXPIRED"],
  SENT: ["ACCEPTED", "REJECTED", "EXPIRED"],
  ACCEPTED: ["REJECTED", "EXPIRED"], // التحويل يتم عبر convertQuotation لا هنا
  REJECTED: [],
  CONVERTED: [],
  EXPIRED: [],
};

/**
 * عزل الفرع للتعديل/التحويل (تدقيق ١٤/٦/٢٦): عرض السعر التزام سعري — إذن التعديل/
 * التحويل أصرم من سائر الكيانات. **admin فقط** يستطيع عبور الفروع لمنع مدير فرع
 * من تحويل عرض فرع آخر إلى فاتورة تُلزم الشركة قانونياً. مدير الفرع يبقى محصوراً
 * بفرعه على هذين الإجراءين (مختلف عن productionService الذي يعدّ manager مرتفعاً).
 */
function assertQuotationBranchStrict(q: { branchId: number | string | null }, actor: Actor & { role?: string },
) {
  if (actor.role === "admin") return;
  if (q.branchId == null || Number(q.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "لا تستطيع العمل على هذا العرض",
        why: "العرض يخص فرعاً غير فرعك، وصلاحية عبور الفروع محصورة بالإدارة",
        doThis: "اطلب من مدير الفرع الذي يملك العرض تعديله أو تحويله، أو ارفع الطلب للإدارة",
      }),
    });
  }
}

/** يحدّث حالة عرض السعر (عدا CONVERTED الذي يتم عبر convertQuotation). */
export async function setQuotationStatus(quotationId: number, status: QuoteStatus, actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const q = (await tx.select().from(quotations).where(eq(quotations.id, quotationId)).for("update").limit(1))[0];
    if (!q)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تغيير حالة عرض السعر",
          why: "الرقم المرسل يشير إلى عرض محذوف أو غير موجود",
          doThis: "أعد تحميل قائمة العروض — العرض قد يكون حُذف أو تغيّر رقمه",
        }),
      });
    assertQuotationBranchStrict(q, actor);
    if (status === "CONVERTED")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "لا يمكن قلب الحالة إلى «محوَّل» يدوياً",
          why: "التحويل حدث مالي (يُنشئ فاتورة ومخزوناً ودفتراً) — لا يجوز إسناده بتغيير حالة",
          doThis: "استعمل زر «تحويل لفاتورة» على العرض المقبول، لا شاشة تغيير الحالة",
        }),
      });
    const allowed = ALLOWED_TRANSITIONS[q.status as QuoteStatus] ?? [];
    if (!allowed.includes(status)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "انتقال الحالة غير مسموح",
          why: `لا يمكن نقل عرض السعر من «${q.status}» إلى «${status}» — الانتقالات المسموحة محدَّدة بمصفوفة انتقالات ثابتة`,
          doThis: "اختر انتقالاً مسموحاً من قائمة الحالات المتاحة (مثلاً: DRAFT→SENT→ACCEPTED)",
        }),
      });
    }
    await tx.update(quotations).set({ status }).where(eq(quotations.id, quotationId));
    return { quotationId, status };
  });
}

export interface ConvertQuotationInput {
  quotationId: number;
  payment?: { amount: string; method: PaymentMethod; reference?: string | null;
    externalPaymentAttemptId?: number | null;
    externalPaymentDeviceId?: string | null;
  } | null;
}

/** يحوّل عرض السعر إلى فاتورة فعلية (بيع كامل: مخزون + دفتر) مرة واحدة فقط. */
export async function convertQuotation(input: ConvertQuotationInput, actor: Actor & { role?: string },
) {
  if (input.payment) {
    assertPosPaymentMethodEnabled(input.payment.method);
    if (input.payment.method === "CASH") {
      if (
        input.payment.externalPaymentAttemptId != null ||
        input.payment.externalPaymentDeviceId?.trim()
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "طريقة الدفع لا تطابق البيانات المرسلة",
            why: "أرسلت معرّف محاولة دفع خارجية (بطاقة/محفظة) مع طريقة دفع CASH — الحقلان يتنافيان",
            doThis: "احذف حقول المحاولة الخارجية من طلب النقد، أو غيّر طريقة الدفع إلى غير نقدية",
          }),
        });
      }
    } else if (!input.payment.externalPaymentAttemptId ||
      !input.payment.externalPaymentDeviceId?.trim()
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: "أكّد الدفع الخارجي قبل تحويل العرض",
          why: "الطرق غير النقدية (بطاقة/محفظة/تحويل) تحتاج محاولة دفع خارجية مؤكَّدة برقم ومعرّف جهاز قبل التحويل",
          doThis: "شغّل الدفع من الطرفية الخارجية وانتظر تأكيدها، ثم أعد التحويل ومعك رقم المحاولة",
        }),
      });
    }
  }

  const conversionHash = idempotencyHash({
    quotationId: input.quotationId,
    payment: input.payment
      ? {
          amount: money(input.payment.amount).toFixed(2),
          method: input.payment.method,
          reference: input.payment.reference?.trim() || null,
          externalPaymentAttemptId:
            input.payment.externalPaymentAttemptId ?? null,
          externalPaymentDeviceId:
            input.payment.externalPaymentDeviceId?.trim() || null,
        }
      : null,
  });

  const outcome = await withTx(
    async (tx) => {
      // العرض هو رأس الانتقال: قفله أولاً يجعل ACCEPTED→CONVERTED يتسلسل مع الرفض/الانتهاء،
      // ثم تبقى الفاتورة والمخزون والإيصال والرابط في معاملة مالية واحدة تحت بوابة الإقفال الشهرية.
      const q = (await tx
          .select().from(quotations).where(eq(quotations.id, input.quotationId)).for("update")
          .limit(1))[0];
      if (!q)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر تحويل عرض السعر",
            why: "الرقم المرسل يشير إلى عرض محذوف أو غير موجود",
            doThis: "أعد تحميل قائمة عروض الأسعار وابحث عن العرض المطلوب — قد يكون حُذف أو تغيّر رقمه",
          }),
        });

  // عزل الفرع (تدقيق ١٤/٦/٢٦): التحويل = إنشاء فاتورة تُلزم الشركة قانونياً. admin فقط
  // يعبُر الفروع — مدير فرع يبقى محصوراً بفرعه (لا يقدر يحوّل عرض فرع آخر).
  assertQuotationBranchStrict(q, actor);

      const storedConversion = await checkIdempotency(
        tx,
        "quotation.convert",
        String(input.quotationId),
        conversionHash,
        { requireStoredHash: true },
      );

      // idempotency على المستند نفسه: بعد قفل العرض، أي محوّل متزامن يرى الرابط الملتزم ويعيد
      // بيانات الفاتورة الحقيقية نفسها؛ الرابط المكسور يفشل مغلقاً ولا يزعم نجاحاً ناقصاً.
      if (q.status === "CONVERTED" && q.convertedInvoiceId) {
    const existing = (await tx
            .select({
              id: invoices.id,
              invoiceNumber: invoices.invoiceNumber,
              status: invoices.status,
            }).from(invoices).where(eq(invoices.id, Number(q.convertedInvoiceId)))
            .limit(1))[0];
        if (!existing) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "بيانات تحويل العرض تالفة",
              why: "العرض مُعلَّم كمحوَّل (CONVERTED) لكن الفاتورة المرتبطة بمعرّف convertedInvoiceId غير موجودة",
              doThis: "أوقف العملية وأبلغ التدقيق برقم العرض — يلزم مراجعة سلامة البيانات قبل أي تحويل جديد",
            }),
          });
        }
        if (
          storedConversion != null &&
          Number(storedConversion) !== Number(existing.id)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: appErrorMessage({
              what: "تعارض في إعادة محاولة تحويل العرض",
              why: "مفتاح idempotency المحفوظ يشير إلى فاتورة مختلفة عن الفاتورة المربوطة بالعرض الآن",
              doThis: "أوقف العملية وأبلغ التدقيق برقم العرض والفاتورة معاً — يلزم مراجعة سجل التحويل",
            }),
          });
        }
        if (input.payment && input.payment.method !== "CASH") {
          await assertExternalPaymentReplay(
            tx,
            Number(existing.id),
            {
              branchId: Number(q.branchId),
              channel: "SALES_COLLECTION",
              method: input.payment.method,
              amount: input.payment.amount,
              attemptId: input.payment.externalPaymentAttemptId,
              deviceId: input.payment.externalPaymentDeviceId,
            },
            actor,
          );
        }
        return {
          result: {
            quotationId: input.quotationId, invoiceId: Number(existing.id),
            invoiceNumber: existing.invoiceNumber, status: existing.status,
            alreadyConverted: true as const,
          },
          notification: null,
        };
  }
  if (q.status !== "ACCEPTED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "لا يمكن تحويل هذا العرض إلى فاتورة",
        why: `التحويل لا يُقبل إلا على عرض مقبول (ACCEPTED)، ولا يُحوَّل عرضٌ قبل قبوله — وحالة العرض حالياً «${q.status}»`,
        doThis: "اطلب من العميل قبول العرض أوّلاً (يُغيَّر حالته إلى ACCEPTED)، ثم أعد التحويل",
      }),
    });
  }
  if (q.validUntil && toDateStr(new Date(q.validUntil as any)) < toDateStr()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "لا يمكن تحويل هذا العرض إلى فاتورة",
        why: `العرض منتهي الصلاحية (validUntil = ${toDateStr(new Date(q.validUntil as any))})، فلا يُلزم بالسعر بعد اليوم`,
        doThis: "أنشئ عرضاً جديداً بأسعار اليوم (نسخ لعرض جديد)، أو مدّد صلاحية العرض بتعديل تاريخه",
      }),
    });
  }

  const items = await tx
        .select().from(quotationItems).where(eq(quotationItems.quotationId, input.quotationId));
      if (!items.length)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "لا يمكن تحويل هذا العرض إلى فاتورة",
            why: "بنود العرض غير موجودة في قاعدة البيانات — قد تكون حُذفت بعد الإنشاء",
            doThis: "أنشئ عرضاً جديداً ببنوده الكاملة، أو أبلغ التدقيق برقم العرض لمراجعة سلامة البنود",
          }),
        });

      // وردية النقد تُحلّ وتُقفل داخل المعاملة نفسها؛ بذلك لا تستطيع وردية أن تُغلق بين الفحص
      // وكتابة الإيصال، ويبقى سلوك createSaleInTx وحارس اليوم النقدي كما هو.
      let shiftId: number | null = null;
  const isCashPayment = input.payment?.method === "CASH" && money(input.payment?.amount ?? "0").gt(0);
  if (isCashPayment) {
        shiftId = await openShiftIdTx(tx, actor.userId, Number(q.branchId));
    if (shiftId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "لا يمكن تحصيل الدفعة النقدية",
          why: "لا توجد وردية مفتوحة باسمك على هذا الفرع — النقد يلزمه درج مفتوح لاستقباله",
          doThis: "افتح وردية من شاشة الورديات ثم أعد التحويل، أو اختر طريقة دفع غير نقدية (بطاقة/تحويل)",
        }),
      });
    }
      }

      // (تدقيق ١٧/٧) نعيد نفس مدخلات الحساب المحفوظة كي يساوي إجمالي الفاتورة إجمالي العرض.
      const saleInput = {
      branchId: Number(q.branchId),
      shiftId,
      customerId: q.customerId ? Number(q.customerId) : null,
      priceTier: q.priceTier as PriceTier,
      sourceType: "ORDER" as const,
      clientRequestId: `QUO-${q.id}`,
      lines: items.map((it) => ({
        variantId: Number(it.variantId),
        productUnitId: Number(it.productUnitId),
        quantity: it.quantity,
        unitPriceOverride: it.unitPrice,
        discountAmount: it.discountAmount ?? null,
      })),
      invoiceDiscount: q.discountAmount ?? "0",
      taxRatePercent: q.taxRatePercent ?? "0",
      payment: input.payment
          ? {
              amount: input.payment.amount,
              method: input.payment.method,
              reference: input.payment.reference ?? null,
            }
          : null,
        notes: `محوّل من عرض السعر ${q.quoteNumber}`,
        // SALES-01/02: التحويل إجراء مدير (convert=managerProcedure) والأسعار أُقِرّت عند إنشاء العرض.
        priceOverrideApproved: true,
    };
      let committedSaleInput = saleInput;
      const sale =
        input.payment && input.payment.method !== "CASH"
          ? await consumeConfirmedExternalPaymentAttemptTx(
              tx,
              {
                branchId: Number(q.branchId),
                channel: "SALES_COLLECTION",
                method: input.payment.method,
                amount: input.payment.amount,
                attemptId: input.payment.externalPaymentAttemptId,
                deviceId: input.payment.externalPaymentDeviceId,
              },
              actor,
              async (attempt) => {
                committedSaleInput = {
                  ...saleInput,
                  payment: {
                    amount: input.payment!.amount,
                    method: input.payment!.method,
                    reference: attempt.externalReference,
                  },
                };
                const created = await createSaleInTx(
                  tx,
                  committedSaleInput,
                  actor,
                );
                const receipt = (
                  await tx
                    .select({
                      id: receipts.id,
                      amount: receipts.amount,
                      paymentMethod: receipts.paymentMethod,
                      referenceNumber: receipts.referenceNumber,
                    })
                    .from(receipts)
                    .where(
                      and(
                        eq(receipts.invoiceId, created.invoiceId),
                        eq(receipts.direction, "IN"),
                        eq(receipts.paymentMethod, input.payment!.method),
                      ),
                    )
                    .orderBy(desc(receipts.id))
                    .limit(1)
                )[0];
                if (
                  !receipt ||
                  !money(receipt.amount).eq(money(input.payment!.amount)) ||
                  (receipt.referenceNumber?.trim() || null) !==
                    attempt.externalReference.trim()
                ) {
                  throw new TRPCError({
                    code: "INTERNAL_SERVER_ERROR",
                    message:
                      "لم يُنشأ إيصال مطابق لمحاولة الدفع — تراجع تحويل العرض بالكامل",
                  });
                }
                return {
                  invoiceId: created.invoiceId,
                  receiptId: Number(receipt.id),
                  value: created,
                };
              },
            )
          : await createSaleInTx(tx, committedSaleInput, actor);

      await tx
        .update(quotations)
    .set({ status: "CONVERTED", convertedInvoiceId: sale.invoiceId })
    .where(eq(quotations.id, input.quotationId));
      await recordIdempotencyKey(
        tx,
        "quotation.convert",
        String(input.quotationId),
        sale.invoiceId,
        conversionHash,
      );

      return {
        result: {
          quotationId: input.quotationId, invoiceId: sale.invoiceId, invoiceNumber: sale.invoiceNumber, status: sale.status, alreadyConverted: false as const,
        },
        notification: { input: committedSaleInput, result: sale },
      };
},
    { gate: "FINANCIAL_WRITER" },
  );

  // أثر خارجي بعد commit حصراً؛ فشله لا يرجع فاتورة/مخزوناً التزما بالفعل.
  if (outcome.notification) {
    try {
      await notifySaleCustomerAfterCommit(
        outcome.notification.input,
        outcome.notification.result,
      );
    } catch {
      // createSale العام يتعامل مع الإشعار بالطريقة نفسها: البيع حقيقة مالية لا تُسقَط بفشل الرسالة.
    }
  }
  return outcome.result;
}

/* ============================ قراءة ============================ */

export interface ListQuotationsInput {
  limit?: number;
  /** فترة على createdAt (YYYY-MM-DD) — «إلى» شاملاً عبر نصف مفتوح [from, to+يوم). */
  from?: string;
  to?: string;
  status?: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "CONVERTED" | "EXPIRED";
  /** عزل الفرع (تدقيق ١٤/٦/٢٦): غير المرتفعين يُجبَرون على فرعهم. */
  branchId?: number | null;
  /** بحث نصّي خادمي: رقم العرض/اسم العميل/الملاحظات. */
  q?: string;
}


export async function listQuotations(input: ListQuotationsInput = {}) {
  const db = getDb();
  if (!db) return [];
  const conds = [];
  // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
  if (input.from) conds.push(gte(quotations.createdAt, localDayStart(input.from)));
  if (input.to) conds.push(lt(quotations.createdAt, localNextDayStart(input.to)));
  if (input.status) conds.push(eq(quotations.status, input.status));
  if (input.branchId != null) conds.push(eq(quotations.branchId, input.branchId));
  // بحث نصّي آمن (escLike + ESCAPE '!'): رقم العرض/اسم العميل/الملاحظات.
  if (input.q) {
    const pat = `%${escLike(input.q.trim())}%`;
    conds.push(
      or(
        sql`${quotations.quoteNumber} LIKE ${pat} ESCAPE '!'`,
        sql`${customers.name} LIKE ${pat} ESCAPE '!'`,
        sql`${quotations.notes} LIKE ${pat} ESCAPE '!'`,
      ) as any,
    );
  }
  return db
    .select({
      id: quotations.id,
      quoteNumber: quotations.quoteNumber,
      quoteDate: quotations.quoteDate,
      validUntil: quotations.validUntil,
      total: quotations.total,
      status: quotations.status,
      convertedInvoiceId: quotations.convertedInvoiceId,
      customerName: customers.name,
    })
    .from(quotations)
    .leftJoin(customers, eq(quotations.customerId, customers.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(quotations.id))
    .limit(input.limit ?? 100);
}

export async function getQuotation(quotationId: number) {
  const db = getDb();
  if (!db) return null;
  const q = (
    await db
      .select({
        id: quotations.id,
        quoteNumber: quotations.quoteNumber,
        branchId: quotations.branchId,
          customerId: quotations.customerId,
          customerName: customers.name,
          customerPhone: customers.phone,
        priceTier: quotations.priceTier,
        quoteDate: quotations.quoteDate,
        validUntil: quotations.validUntil,
        subtotal: quotations.subtotal,
        taxAmount: quotations.taxAmount,
        taxRatePercent: quotations.taxRatePercent,
        discountAmount: quotations.discountAmount,
        total: quotations.total,
        status: quotations.status,
        convertedInvoiceId: quotations.convertedInvoiceId,
        notes: quotations.notes,
      })
      .from(quotations)
      .leftJoin(customers, eq(quotations.customerId, customers.id))
      .where(eq(quotations.id, quotationId))
      .limit(1)
  )[0];
  if (!q) return null;
  const items = await db
    .select({
      id: quotationItems.id,
      variantId: quotationItems.variantId,
      productId: productVariants.productId,
      productUnitId: quotationItems.productUnitId,
      quantity: quotationItems.quantity,
      baseQuantity: quotationItems.baseQuantity,
      unitPrice: quotationItems.unitPrice,
      discountAmount: quotationItems.discountAmount,
      total: quotationItems.total,
      productName: products.name,
      sku: productVariants.sku,
      variantName: productVariants.variantName,
      costBase: productVariants.costPrice,
      unitName: productUnits.unitName,
      conversionFactor: productUnits.conversionFactor,
      barcode: productUnits.barcode,
    })
    .from(quotationItems)
    .leftJoin(productVariants, eq(quotationItems.variantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(productUnits, eq(quotationItems.productUnitId, productUnits.id))
    .where(eq(quotationItems.quotationId, quotationId));
  return { ...q, items };
}
