import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { computeInvoiceTotals, computeLineTotal } from "../billing";
import { money } from "../money";
import type { DigitalCheckoutRegularLineInput } from "../../../shared/digitalSale";
import { appErrorMessage } from "../../../shared/errors";

const nonNegativeMoney = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "المبلغ يجب أن يكون غير سالب وبمنزلتين عشريتين كحد أقصى");

const percent = nonNegativeMoney.refine(
  (value) => money(value).lte(100),
  "النسبة يجب أن تكون بين ٠ و١٠٠",
);

const positiveQuantity = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, "الكمية يجب أن تكون موجبة وبثلاث منازل عشرية كحد أقصى")
  .refine((value) => money(value).gt(0), "الكمية يجب أن تكون موجبة");

function isMysqlCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ الاستحقاق غير صالح")
  .refine(isMysqlCalendarDate, "تاريخ الاستحقاق غير صالح تقويمياً");

export const invoiceSourceLineSchema = z
  .object({
    variantId: z.number().int().positive(),
    productUnitId: z.number().int().positive(),
    quantity: positiveQuantity,
    unitPriceOverride: nonNegativeMoney.optional(),
    discountPercent: percent.optional(),
    discountAmount: nonNegativeMoney.optional(),
    isGift: z.boolean().optional(),
    /** Present only on digital instances; one token always represents one issued card. */
    internalLineToken: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/**
 * Durable, non-secret snapshot of the advanced invoice editor.
 *
 * Authentication material (notably `managerApproval`) is deliberately absent: the snapshot is
 * persisted with the intent and must never become a password store.  Payment authority and card
 * prices remain locked by the intent itself; this payload preserves only the invoice presentation
 * and discount/tax/delivery instructions that `createSaleInTx` must replay after issuance.
 */
export const invoiceSourcePayloadSchema = z
  .object({
    branchId: z.number().int().positive(),
    shiftId: z.number().int().positive(),
    customerId: z.number().int().positive().optional(),
    priceTier: z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]),
    lines: z.array(invoiceSourceLineSchema).min(1).max(150),
    deliveryFee: nonNegativeMoney.optional(),
    deliveryFree: z.boolean().optional(),
    deliveryWaivedAmount: nonNegativeMoney.optional(),
    invoiceDiscount: nonNegativeMoney.optional(),
    taxRatePercent: nonNegativeMoney.optional(),
    payment: z
      .object({
        amount: nonNegativeMoney,
        method: z.enum(["CASH", "CARD"]),
        externalPaymentAttemptId: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    deviceId: z.string().trim().min(1).max(64).optional(),
    dueDate: calendarDate.optional(),
    clientRequestId: z.string().min(8).max(80),
    notes: z.string().max(5000).optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.deliveryFree === true && payload.deliveryFee != null && money(payload.deliveryFee).gt(0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryFee"],
        message: "لا تُجمع أجرة توصيل مدفوعة مع وسم التوصيل المجاني",
      });
    }
    if (payload.deliveryFree !== true && payload.deliveryWaivedAmount != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryWaivedAmount"],
        message: "قيمة التوصيل المتنازل عنها تتطلب وسم التوصيل المجاني",
      });
    }
    if (payload.deliveryFree === true && money(payload.deliveryWaivedAmount ?? "0").lte(0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryWaivedAmount"],
        message: "قيمة التوصيل المتنازل عنها مطلوبة عند التوصيل المجاني",
      });
    }
    if (money(payload.taxRatePercent ?? "0").gt(100)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["taxRatePercent"],
        message: "نسبة الضريبة يجب أن تكون بين ٠ و١٠٠",
      });
    }
  });

export type InvoiceSourcePayload = z.infer<typeof invoiceSourcePayloadSchema>;
export type InvoiceSourceLine = z.infer<typeof invoiceSourceLineSchema>;

function sourcePayloadError(message: string): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: appErrorMessage({
      what: "حمولة فاتورة البيع الرقمية غير صالحة",
      why: message,
      doThis: "أعد تحميل الفاتورة وأنشئ سلة الكروت من بياناتها الحالية ثم أعد المحاولة",
    }),
  });
}

export function parseInvoiceSourcePayload(value: unknown): InvoiceSourcePayload {
  const parsed = invoiceSourcePayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw sourcePayloadError(parsed.error.issues[0]?.message ?? "أعد إنشاء السلة قبل إصدار الكروت");
  }
  return parsed.data;
}

export function assertInvoiceSourceEnvelope(
  payload: InvoiceSourcePayload,
  expected: {
    branchId: number;
    shiftId: number;
    customerId?: number | null;
    priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT" | null;
    clientRequestId: string;
  },
): void {
  if (
    payload.branchId !== expected.branchId ||
    payload.shiftId !== expected.shiftId ||
    (payload.customerId ?? null) !== (expected.customerId ?? null) ||
    payload.priceTier !== expected.priceTier ||
    payload.clientRequestId !== expected.clientRequestId
  ) {
    throw sourcePayloadError("بيانات الفرع أو الوردية أو العميل أو مفتاح الطلب لا تطابق النيّة");
  }
}

export interface InvoiceDigitalPriceLine {
  lineKey: string;
  variantId: number;
  productUnitId: number;
  sellPrice: string;
}

function normalizedLine(value: {
  variantId: number;
  productUnitId: number;
  quantity: string;
  unitPriceOverride?: string | null;
  discountPercent?: string | null;
  discountAmount?: string | null;
  isGift?: boolean;
}): string {
  return JSON.stringify({
    variantId: Number(value.variantId),
    productUnitId: Number(value.productUnitId),
    quantity: money(value.quantity).toString(),
    unitPriceOverride:
      value.unitPriceOverride == null
        ? null
        : money(value.unitPriceOverride).toFixed(2),
    discountPercent:
      value.discountPercent == null
        ? null
        : money(value.discountPercent).toFixed(2),
    discountAmount:
      value.discountAmount == null
        ? null
        : money(value.discountAmount).toFixed(2),
    isGift: value.isGift === true,
  });
}

/** يمنع اختلاف حمولة الفاتورة الدائمة عن البنود العادية التي سعّرها الخادم. */
export function assertInvoiceLinePartition(
  payload: InvoiceSourcePayload,
  regularLines: readonly DigitalCheckoutRegularLineInput[],
): void {
  const payloadRegular = payload.lines
    .filter((line) => line.internalLineToken == null)
    .map(normalizedLine)
    .sort();
  const requestedRegular = regularLines.map(normalizedLine).sort();
  if (
    payloadRegular.length !== requestedRegular.length ||
    payloadRegular.some((line, index) => line !== requestedRegular[index])
  ) {
    throw sourcePayloadError(
      "البنود العادية في الفاتورة لا تطابق البنود التي سُعّرت وحُجزت",
    );
  }
}

/** Bind each durable invoice line to exactly one intent item; quantities can never collapse cards. */
export function bindInvoiceDigitalLines(
  payload: InvoiceSourcePayload,
  digitalLines: readonly InvoiceDigitalPriceLine[],
): Map<string, InvoiceSourceLine> {
  const indexed = new Map<string, InvoiceSourceLine>();
  for (const line of payload.lines) {
    const token = line.internalLineToken;
    if (token == null) continue;
    if (indexed.has(token)) throw sourcePayloadError("مفتاح كرت رقمي مكرر في سطور الفاتورة");
    indexed.set(token, line);
  }

  if (indexed.size !== digitalLines.length) {
    throw sourcePayloadError("عدد مثيلات الكروت لا يطابق بنود النيّة");
  }
  for (const digital of digitalLines) {
    const source = indexed.get(digital.lineKey);
    if (!source) throw sourcePayloadError("تعذّر ربط كرت رقمي بسطره الأصلي");
    if (
      source.variantId !== digital.variantId ||
      source.productUnitId !== digital.productUnitId ||
      !money(source.quantity).eq(1)
    ) {
      throw sourcePayloadError("هوية الكرت أو كميته تغيّرت بعد إعداد الفاتورة");
    }
    if (
      source.isGift !== true &&
      source.unitPriceOverride != null &&
      !money(source.unitPriceOverride).eq(money(digital.sellPrice))
    ) {
      throw sourcePayloadError("سعر الكرت في الفاتورة لا يطابق سعر النيّة الموثّق");
    }
  }
  return indexed;
}

/** Exact mirror of the sale core: rounded line totals, then header discount/tax/delivery. */
export function computeInvoiceIntentTotal(input: {
  regularSubtotal: string;
  digitalLines: readonly InvoiceDigitalPriceLine[];
  sourcePayload: InvoiceSourcePayload;
}): {
  total: string;
  subtotal: string;
  discountAmount: string;
  digitalLineTotals: Map<string, string>;
  digitalSourceLines: Map<string, InvoiceSourceLine>;
} {
  if (
    money(input.sourcePayload.invoiceDiscount ?? "0").gt(0) ||
    money(input.sourcePayload.taxRatePercent ?? "0").gt(0) ||
    money(input.sourcePayload.deliveryFee ?? "0").gt(0) ||
    input.sourcePayload.deliveryFree === true
  ) {
    throw sourcePayloadError(
      "لا تُجمع الكروت الرقمية حالياً مع خصم رأس الفاتورة أو الضريبة أو التوصيل؛ هذه القيم تحتاج توزيع استرداد مستقل لكل بند",
    );
  }
  const digitalSourceLines = bindInvoiceDigitalLines(input.sourcePayload, input.digitalLines);
  if (
    Array.from(digitalSourceLines.values()).some((line) => line.isGift === true)
  ) {
    throw sourcePayloadError(
      "إهداء كرت صادر غير مدعوم آلياً؛ مسار عكسه يحتاج قيد هدية مستقل لا استرداد بيع عادي",
    );
  }
  const digitalLineTotals = new Map<string, string>();
  const digitalTotals = input.digitalLines.map((digital) => {
    const source = digitalSourceLines.get(digital.lineKey)!;
    const total = source.isGift === true ? "0.00" : computeLineTotal({
      unitPrice: money(digital.sellPrice),
      quantity: money(1),
      discountAmount: source.discountAmount,
      discountPercent: source.discountPercent,
    }).total;
    digitalLineTotals.set(digital.lineKey, total);
    return total;
  });
  const totals = computeInvoiceTotals({
    lineTotals: [input.regularSubtotal, ...digitalTotals],
    invoiceDiscount: input.sourcePayload.invoiceDiscount,
    taxRatePercent: input.sourcePayload.taxRatePercent,
    deliveryFee: input.sourcePayload.deliveryFee,
  });
  return {
    total: totals.total,
    subtotal: totals.subtotal,
    discountAmount: totals.discountAmount,
    digitalLineTotals,
    digitalSourceLines,
  };
}

export function assertInvoiceFullPayment(
  payload: InvoiceSourcePayload,
  expected: {
    paymentMethod: string;
    paymentAmount: string;
    externalPaymentAttemptId?: number | null;
    externalPaymentDeviceId?: string | null;
  },
): void {
  const payment = payload.payment;
  if (expected.paymentMethod === "CREDIT") {
    // لا يفتح هذا إنشاء بيع آجل جديداً (prepare يرفضه). يسمح فقط بتعافي نيّة تاريخية
    // سبقت الحارس، شريطة ألا تدّعي قبضاً أو تحمل إيصال دفع داخل حمولة الفاتورة.
    if (!money(expected.paymentAmount).eq(0) || payment != null) {
      throw sourcePayloadError("نيّة البيع الآجل التاريخية يجب ألا تتضمن مبلغاً مقبوضاً");
    }
    return;
  }
  if (expected.paymentMethod !== "CASH" && expected.paymentMethod !== "CARD") {
    throw sourcePayloadError("طريقة دفع النيّة الرقمية غير مدعومة");
  }
  if (money(expected.paymentAmount).gt(0) && payment == null) {
    throw sourcePayloadError("يجب قبض كامل الفاتورة قبل إصدار الكروت");
  }
  if (payment != null && (
    payment.method !== expected.paymentMethod ||
    !money(payment.amount).eq(money(expected.paymentAmount))
  )) {
    throw sourcePayloadError("طريقة الدفع أو المبلغ المقبوض لا يطابق إجمالي النيّة");
  }
  if (expected.paymentMethod === "CARD") {
    if (
      payment?.externalPaymentAttemptId !== expected.externalPaymentAttemptId ||
      payload.deviceId !== expected.externalPaymentDeviceId
    ) {
      throw sourcePayloadError("إثبات دفع البطاقة لا يطابق النيّة");
    }
  }
}
