import { TRPCError } from "@trpc/server";
import {
  isWithinPriceDecimals,
  priceDecimalsMessage,
} from "@shared/moneyPrecision";
import Decimal from "decimal.js";
import { money, round2, toDbMoney } from "../money";
import { sha256, stableCanonical } from "./grniAccounting";

export type SupplierInvoiceDraftEvidenceType =
  | "DOCUMENT_IMAGE"
  | "PDF"
  | "EMAIL"
  | "EDI"
  | "OTHER";

export interface SupplierInvoiceDraftLineInput {
  purchaseOrderRevisionItemId: number;
  description: string;
  invoicedBaseQuantity: number;
  unitPrice: string;
}

export interface SupplierInvoiceDraftDocumentInput {
  externalInvoiceNumber: string;
  invoiceDate: string;
  dueDate?: string | null;
  agreedRate?: string | null;
  taxAmount?: string | null;
  discountAmount?: string | null;
  evidenceType: SupplierInvoiceDraftEvidenceType;
  evidenceReference: string;
  lines: SupplierInvoiceDraftLineInput[];
}

export interface SupplierInvoiceDraftIdentity {
  supplierId: number;
  branchId: number;
  currency: "IQD" | "USD";
}

type SupplierInvoiceMoneyValue = string | number | Decimal;

function asSupplierInvoiceMoney(value: SupplierInvoiceMoneyValue): Decimal {
  return value instanceof Decimal ? value : money(value);
}

/**
 * Allocate a rounded money amount by non-negative weights without losing a
 * fils/cent. Floors are assigned first, then the remaining cents go to the
 * largest fractional remainders; equal remainders use the supplied stable key.
 */
export function allocateRoundedMoneyByWeight(
  totalInput: SupplierInvoiceMoneyValue,
  weightInputs: SupplierInvoiceMoneyValue[],
  stableKeys: number[] = weightInputs.map((_, index) => index),
): Decimal[] {
  const total = round2(asSupplierInvoiceMoney(totalInput));
  if (total.isNegative())
    throw new Error("cannot allocate a negative money amount");
  if (stableKeys.length !== weightInputs.length)
    throw new Error("allocation keys must match allocation weights");
  if (!weightInputs.length) {
    if (!total.isZero()) throw new Error("cannot allocate money without lines");
    return [];
  }
  const weights = weightInputs.map(asSupplierInvoiceMoney);
  if (weights.some((weight) => weight.isNegative()))
    throw new Error("allocation weights cannot be negative");
  const weightTotal = weights.reduce(
    (sum, weight) => sum.plus(weight),
    money(0),
  );
  const targetCents = total.times(100);
  if (weightTotal.isZero()) {
    const result = weights.map(() => money(0));
    const firstIndex = stableKeys
      .map((key, index) => ({ key, index }))
      .sort((a, b) => a.key - b.key || a.index - b.index)[0]!.index;
    result[firstIndex] = total;
    return result;
  }

  const rows = weights.map((weight, index) => {
    const rawCents = targetCents.times(weight).dividedBy(weightTotal);
    const cents = rawCents.floor();
    return {
      index,
      stableKey: stableKeys[index]!,
      cents,
      fraction: rawCents.minus(cents),
    };
  });
  const assigned = rows.reduce((sum, row) => sum.plus(row.cents), money(0));
  const remaining = targetCents.minus(assigned).toNumber();
  const ranked = [...rows].sort(
    (a, b) =>
      b.fraction.comparedTo(a.fraction) ||
      a.stableKey - b.stableKey ||
      a.index - b.index,
  );
  for (let index = 0; index < remaining; index += 1) {
    ranked[index]!.cents = ranked[index]!.cents.plus(1);
  }
  const result = rows.map(() => money(0));
  for (const row of rows) result[row.index] = row.cents.dividedBy(100);
  return result;
}

export function allocateSupplierInvoiceHeaderAmounts<
  T extends { lineNo: number; netAmount: SupplierInvoiceMoneyValue },
>(
  lines: T[],
  taxInput: SupplierInvoiceMoneyValue,
  discountInput: SupplierInvoiceMoneyValue,
) {
  if (!lines.length)
    throw new Error("supplier invoice allocation requires at least one line");
  const grossAmounts = lines.map((line) =>
    round2(asSupplierInvoiceMoney(line.netAmount)),
  );
  if (grossAmounts.some((amount) => amount.isNegative()))
    throw new Error("supplier invoice line amount cannot be negative");
  const subtotal = round2(
    grossAmounts.reduce((sum, amount) => sum.plus(amount), money(0)),
  );
  const tax = round2(asSupplierInvoiceMoney(taxInput));
  const discount = round2(asSupplierInvoiceMoney(discountInput));
  if (tax.isNegative() || discount.isNegative())
    throw new Error("supplier invoice tax and discount cannot be negative");
  if (discount.gt(subtotal))
    throw new Error("supplier invoice discount cannot exceed its subtotal");
  const stableKeys = lines.map((line) => line.lineNo);
  const allocatedTax = allocateRoundedMoneyByWeight(
    tax,
    grossAmounts,
    stableKeys,
  );
  const allocatedDiscount = allocateRoundedMoneyByWeight(
    discount,
    grossAmounts,
    stableKeys,
  );

  return lines.map((line, index) => {
    const grossNetAmount = grossAmounts[index]!;
    const discountAmount = allocatedDiscount[index]!;
    const netAmount = round2(grossNetAmount.minus(discountAmount));
    const taxAmount = allocatedTax[index]!;
    return {
      ...line,
      grossNetAmount,
      discountAmount,
      netAmount,
      taxAmount,
      totalAmount: round2(netAmount.plus(taxAmount)),
    };
  });
}

function required(
  value: string | null | undefined,
  label: string,
  max: number,
): string {
  const text = value?.trim() ?? "";
  if (!text)
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  if (text.length > max)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${label} يجب ألا يتجاوز ${max} محرفاً`,
    });
  return text;
}

export function normalizeSupplierExternalInvoiceNumber(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function validDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

export function buildSupplierInvoiceDraftDocument(
  identity: SupplierInvoiceDraftIdentity,
  input: SupplierInvoiceDraftDocumentInput,
) {
  const externalInvoiceNumber = required(
    input.externalInvoiceNumber,
    "رقم فاتورة المورد",
    160,
  );
  const externalNumberNorm = normalizeSupplierExternalInvoiceNumber(
    externalInvoiceNumber,
  );
  const evidenceReference = required(
    input.evidenceReference,
    "مرجع دليل فاتورة المورد",
    500,
  );
  if (
    !validDate(input.invoiceDate) ||
    (input.dueDate != null && !validDate(input.dueDate))
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "تاريخ فاتورة المورد أو الاستحقاق غير صالح",
    });
  }
  if (!input.lines.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أضف بند فاتورة واحداً على الأقل",
    });
  if (input.lines.length > 500)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "فاتورة المورد لا تقبل أكثر من 500 بند",
    });
  const revisionItemIds = input.lines.map(
    (line) => line.purchaseOrderRevisionItemId,
  );
  if (
    new Set(revisionItemIds).size !== revisionItemIds.length ||
    revisionItemIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "بنود نسخ أوامر الشراء مكررة أو غير صالحة",
    });
  }

  // Header inputs are always expressed in the supplier document currency.
  // The persisted tax/discount columns remain IQD book amounts.
  const documentTax = round2(money(input.taxAmount ?? "0"));
  const documentDiscount = round2(money(input.discountAmount ?? "0"));
  if (documentTax.isNegative() || documentDiscount.isNegative()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الضريبة والخصم لا يقبلان السالب",
    });
  }
  const rate =
    identity.currency === "USD" ? money(input.agreedRate ?? "0") : money(1);
  if (identity.currency === "USD" && !rate.isPositive()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "سعر التثبيت مطلوب للفاتورة الدولارية",
    });
  }

  const baseLines = input.lines.map((line, index) => {
    if (
      !Number.isSafeInteger(line.invoicedBaseQuantity) ||
      line.invoicedBaseQuantity <= 0
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "كمية الفاتورة يجب أن تكون عدد أساس صحيحاً موجباً",
      });
    }
    const description = required(
      line.description,
      `وصف بند الفاتورة ${index + 1}`,
      500,
    );
    if (!isWithinPriceDecimals(line.unitPrice, identity.currency)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: priceDecimalsMessage(
          identity.currency,
          description,
          line.unitPrice,
        ),
      });
    }
    const documentUnitPrice = money(line.unitPrice);
    if (documentUnitPrice.isNegative()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "سعر فاتورة المورد لا يقبل السالب",
      });
    }
    const unitPriceIqd =
      identity.currency === "USD"
        ? round2(documentUnitPrice.times(rate))
        : round2(documentUnitPrice);
    const usdTotal =
      identity.currency === "USD"
        ? round2(documentUnitPrice.times(line.invoicedBaseQuantity))
        : null;
    // إجمالي السطر الدولاري يُحوَّل بعد الضرب؛ ضرب سعر IQD المقرّب في كمية كبيرة يراكم فرقاً وهمياً.
    const netAmount =
      identity.currency === "USD"
        ? round2(usdTotal!.times(rate))
        : round2(documentUnitPrice.times(line.invoicedBaseQuantity));
    return {
      lineNo: index + 1,
      purchaseOrderRevisionItemId: line.purchaseOrderRevisionItemId,
      description,
      invoicedBaseQuantity: line.invoicedBaseQuantity,
      unitPriceIqd,
      netAmount,
      usdUnitPrice: identity.currency === "USD" ? documentUnitPrice : null,
      usdTotal,
    };
  });
  const documentSubtotal = round2(
    baseLines.reduce(
      (sum, line) =>
        sum.plus(
          identity.currency === "USD" ? line.usdTotal! : line.netAmount,
        ),
      money(0),
    ),
  );
  if (documentDiscount.gt(documentSubtotal)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "خصم الفاتورة يتجاوز قيمتها",
    });
  }
  let lines: Array<
    (typeof baseLines)[number] & {
      grossNetAmount: Decimal;
      discountAmount: Decimal;
      netAmount: Decimal;
      taxAmount: Decimal;
      totalAmount: Decimal;
      usdTotal: Decimal | null;
    }
  >;
  let subtotal: Decimal;
  let tax: Decimal;
  let discount: Decimal;
  let total: Decimal;
  let usdTotal: Decimal | null;
  if (identity.currency === "USD") {
    const documentLines = allocateSupplierInvoiceHeaderAmounts(
      baseLines.map((line) => ({ ...line, netAmount: line.usdTotal! })),
      documentTax,
      documentDiscount,
    );
    let priorGrossIqd = money(0);
    let priorNetIqd = money(0);
    let priorTotalIqd = money(0);
    let cumulativeGrossUsd = money(0);
    let cumulativeNetUsd = money(0);
    let cumulativeTotalUsd = money(0);
    lines = documentLines.map((line) => {
      cumulativeGrossUsd = cumulativeGrossUsd.plus(line.grossNetAmount);
      cumulativeNetUsd = cumulativeNetUsd.plus(line.netAmount);
      cumulativeTotalUsd = cumulativeTotalUsd.plus(line.totalAmount);
      const nextGrossIqd = round2(cumulativeGrossUsd.times(rate));
      const nextNetIqd = round2(cumulativeNetUsd.times(rate));
      const nextTotalIqd = round2(cumulativeTotalUsd.times(rate));
      const grossNetAmount = nextGrossIqd.minus(priorGrossIqd);
      const netAmount = nextNetIqd.minus(priorNetIqd);
      const totalAmount = nextTotalIqd.minus(priorTotalIqd);
      priorGrossIqd = nextGrossIqd;
      priorNetIqd = nextNetIqd;
      priorTotalIqd = nextTotalIqd;
      return {
        ...line,
        grossNetAmount,
        discountAmount: grossNetAmount.minus(netAmount),
        netAmount,
        taxAmount: totalAmount.minus(netAmount),
        totalAmount,
        usdTotal: line.totalAmount,
      };
    });
    subtotal = round2(
      lines.reduce((sum, line) => sum.plus(line.grossNetAmount), money(0)),
    );
    discount = round2(
      lines.reduce((sum, line) => sum.plus(line.discountAmount), money(0)),
    );
    tax = round2(
      lines.reduce((sum, line) => sum.plus(line.taxAmount), money(0)),
    );
    total = round2(lines.reduce((sum, line) => sum.plus(line.totalAmount), money(0)));
    usdTotal = round2(
      documentSubtotal.plus(documentTax).minus(documentDiscount),
    );
  } else {
    lines = allocateSupplierInvoiceHeaderAmounts(
      baseLines,
      documentTax,
      documentDiscount,
    );
    subtotal = documentSubtotal;
    tax = documentTax;
    discount = documentDiscount;
    total = round2(subtotal.plus(tax).minus(discount));
    usdTotal = null;
  }
  const canonical = stableCanonical({
    ...identity,
    externalInvoiceNumber,
    externalNumberNorm,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate ?? null,
    currency: identity.currency,
    agreedRate: identity.currency === "USD" ? rate.toFixed(4) : null,
    subtotal: toDbMoney(subtotal),
    taxAmount: toDbMoney(tax),
    discountAmount: toDbMoney(discount),
    documentTaxAmount: toDbMoney(documentTax),
    documentDiscountAmount: toDbMoney(documentDiscount),
    totalAmount: toDbMoney(total),
    usdTotal: usdTotal == null ? null : toDbMoney(usdTotal),
    evidenceType: input.evidenceType,
    evidenceReference,
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      purchaseOrderRevisionItemId: line.purchaseOrderRevisionItemId,
      description: line.description,
      invoicedBaseQuantity: line.invoicedBaseQuantity,
      unitPriceIqd: toDbMoney(line.unitPriceIqd),
      grossNetAmount: toDbMoney(line.grossNetAmount),
      discountAmount: toDbMoney(line.discountAmount),
      netAmount: toDbMoney(line.netAmount),
      taxAmount: toDbMoney(line.taxAmount),
      totalAmount: toDbMoney(line.totalAmount),
      usdUnitPrice: line.usdUnitPrice?.toFixed(4) ?? null,
      usdTotal: line.usdTotal == null ? null : toDbMoney(line.usdTotal),
    })),
  });
  return {
    externalInvoiceNumber,
    externalNumberNorm,
    evidenceReference,
    rate,
    tax,
    discount,
    subtotal,
    total,
    usdTotal,
    lines,
    canonical,
    payloadHash: sha256(canonical),
    revisionItemIds,
  };
}

export function buildSupplierInvoiceDraftRequestHash(input: {
  action: "UPDATE_DRAFT" | "VOID_DRAFT";
  supplierInvoiceId: number;
  expectedVersion: number;
  reason: string;
  document?: SupplierInvoiceDraftDocumentInput;
}): string {
  return sha256(stableCanonical(input));
}
