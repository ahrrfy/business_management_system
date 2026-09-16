/**
 * تحويلُ طلب الإرجاع القديم إلى حقائق قرارٍ صادقة.
 *
 * الطلب القديم لا يحمل سوى `invoiceItemId` و`baseQuantity`؛ لذلك لا يجوز قراءة إجمالي
 * الفاتورة أو كلمة «بند» منه. يستقبل هذا المحوّل لقطةَ الفاتورة وبنودها المجمّدة، ويشتق:
 * قيمةَ البنود، والسقف المحتمل لخروج المال، والتصنيف، وتفاصيل العرض. وهو نقيّ كي يبقى
 * حساب المال مختبَراً بلا قاعدة بيانات.
 */
import Decimal from "decimal.js";
import type {
  DecisionSummaryItem,
  DecisionTrigger,
} from "@shared/decisionRegistry";
import { paymentMethodCompact } from "@shared/terms";

export interface ReturnRequestDecisionLine {
  invoiceItemId: number;
  baseQuantity: number;
}

export interface ReturnRequestDecisionItem {
  id: number;
  itemNameSnapshot?: string | null;
  productName?: string | null;
  variantName?: string | null;
  sku?: string | null;
  unitName?: string | null;
  conversionFactor?: number | null;
  total: string | number | null | undefined;
  baseQuantity: number;
  returnedBaseQuantity?: number | null;
  unitPrice: string | number | null | undefined;
}

export interface ReturnRequestDecisionInvoice {
  subtotal: string | number | null | undefined;
  discountAmount: string | number | null | undefined;
  taxAmount: string | number | null | undefined;
  total: string | number | null | undefined;
  paidAmount: string | number | null | undefined;
  returnedTotal?: string | number | null | undefined;
  paymentMethod?: string | null;
  createdAt?: Date | string | null;
  createdByName?: string | null;
}

export interface ReturnRequestDecisionView {
  /** قيمة البنود المطلوب إرجاعها، لا إجمالي الفاتورة. */
  amount: string | null;
  /** أقصى مبلغ يمكن أن يصبح مستحقاً للعميل ويخرج عند الاعتماد. */
  cashOutCap: string | null;
  trigger: DecisionTrigger | null;
  summaryItems: DecisionSummaryItem[];
}

function decimal(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const result = new Decimal(typeof value === "number" ? value : String(value).trim());
    return result.isFinite() ? result : null;
  } catch {
    return null;
  }
}

function fixed(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function nonNegative(value: Decimal): Decimal {
  return value.isNegative() ? new Decimal(0) : value;
}

function round(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function itemName(item: ReturnRequestDecisionItem): string {
  const snapshot = item.itemNameSnapshot?.trim();
  if (snapshot) return snapshot;
  const live = [item.productName, item.variantName]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(" · ");
  return live || item.sku?.trim() || `بند الفاتورة #${item.id}`;
}

function timestamp(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function lineSummary(
  line: ReturnRequestDecisionLine,
  item: ReturnRequestDecisionItem | undefined,
): DecisionSummaryItem {
  if (!item) {
    return {
      label: `بند الفاتورة #${line.invoiceItemId} — تعذّر تحميل اسمه`,
      qty: line.baseQuantity,
      unit: "وحدة أساس",
    };
  }

  const factor = Number.isInteger(item.conversionFactor) && Number(item.conversionFactor) > 0
    ? Number(item.conversionFactor)
    : 1;
  const asSellingUnit = factor > 1 && line.baseQuantity % factor === 0;
  const qty = asSellingUnit ? line.baseQuantity / factor : line.baseQuantity;
  const unit = asSellingUnit
    ? `${item.unitName?.trim() || "وحدة"} (${line.baseQuantity} قطعة)`
    : item.unitName?.trim() && factor === 1
      ? item.unitName.trim()
      : "قطعة";
  const rawUnitPrice = decimal(item.unitPrice);
  const unitPrice = rawUnitPrice
    ? fixed(asSellingUnit || factor === 1 ? rawUnitPrice : rawUnitPrice.dividedBy(factor))
    : null;
  return { label: itemName(item), qty, unit, unitPrice };
}

export function buildReturnRequestDecisionView(args: {
  invoice: ReturnRequestDecisionInvoice;
  lines: ReturnRequestDecisionLine[];
  items: ReturnRequestDecisionItem[];
  /** المقبوض المادي المتبقي من الإيصالات المعتمدة (IN − OUT). */
  refundable: string | number | null | undefined;
}): ReturnRequestDecisionView {
  const byId = new Map(args.items.map((item) => [Number(item.id), item]));
  const summaries = args.lines.map((line) => lineSummary(line, byId.get(Number(line.invoiceItemId))));
  const requestedById = new Map<number, number>();
  let valid = args.lines.length > 0;
  let gross = new Decimal(0);

  for (const line of args.lines) {
    const itemId = Number(line.invoiceItemId);
    const item = byId.get(itemId);
    const requestedQty = Number(line.baseQuantity);
    const lineTotal = item ? decimal(item.total) : null;
    const returnedQty = Number(item?.returnedBaseQuantity ?? 0);
    const remaining = item ? item.baseQuantity - returnedQty : 0;
    if (
      !item
      || requestedById.has(itemId)
      || !Number.isInteger(requestedQty)
      || requestedQty <= 0
      || !Number.isInteger(item.baseQuantity)
      || item.baseQuantity <= 0
      || !Number.isInteger(returnedQty)
      || returnedQty < 0
      || remaining < requestedQty
      || !lineTotal
    ) {
      valid = false;
      continue;
    }
    requestedById.set(itemId, requestedQty);
    gross = gross.plus(
      lineTotal.times(new Decimal(requestedQty).dividedBy(item.baseQuantity)),
    );
  }

  const subtotal = decimal(args.invoice.subtotal);
  const discount = decimal(args.invoice.discountAmount);
  const tax = decimal(args.invoice.taxAmount);
  const paid = decimal(args.invoice.paidAmount);
  const total = decimal(args.invoice.total);
  const returned = decimal(args.invoice.returnedTotal ?? "0");
  const refundable = decimal(args.refundable);
  const completesInvoice = valid && args.items.length > 0 && args.items.every((item) => {
    const returnedQty = Number(item.returnedBaseQuantity ?? 0);
    return Number.isInteger(returnedQty)
      && returnedQty >= 0
      && returnedQty <= item.baseQuantity
      && (requestedById.get(Number(item.id)) ?? 0) === item.baseQuantity - returnedQty;
  });
  let returnValue: Decimal | null = null;
  if (valid && subtotal && discount && tax && total && returned) {
    if (completesInvoice) {
      returnValue = round(total.minus(returned));
    } else {
      const discountRatio = subtotal.gt(0) ? discount.dividedBy(subtotal) : new Decimal(0);
      const taxable = subtotal.minus(discount);
      const taxRate = taxable.gt(0) ? tax.dividedBy(taxable) : new Decimal(0);
      const revenue = round(gross.times(new Decimal(1).minus(discountRatio)));
      returnValue = round(revenue.plus(round(revenue.times(taxRate))));
    }
  }
  const amount = returnValue ? fixed(returnValue) : null;
  let cashOutCap: string | null = null;
  let trigger: DecisionTrigger | null = null;

  if (returnValue && paid && total && returned && refundable) {
    const netAfterReturn = nonNegative(total.minus(returned).minus(returnValue));
    const owedBack = nonNegative(paid.minus(netAfterReturn));
    const availableReceipts = nonNegative(refundable);
    const possibleCashOut = Decimal.min(owedBack, availableReceipts);
    cashOutCap = fixed(possibleCashOut);
    trigger = possibleCashOut.gt(0) ? "MONEY_OUT" : "ERASE_EFFECT";
  }

  const paidText = paid ? fixed(nonNegative(paid)) : null;
  const totalText = total ? fixed(nonNegative(total)) : null;
  const paymentLabel = paid?.gt(0)
    ? `طريقة القبض: ${paymentMethodCompact(args.invoice.paymentMethod)}`
    : "طريقة القبض: لا توجد دفعة مسجلة";
  const createdAt = timestamp(args.invoice.createdAt);

  const summaryItems: DecisionSummaryItem[] = [
    ...summaries,
    {
      label: amount
        ? "قيمة الأصناف المطلوب إرجاعها"
        : "تعذّر حساب قيمة الأصناف — راجع الطلب في الشاشة الكاملة",
      unitPrice: amount,
    },
    { label: "إجمالي الفاتورة (للسياق)", unitPrice: totalText },
    { label: "المقبوض على الفاتورة", unitPrice: paidText },
    { label: paymentLabel },
    cashOutCap === null
      ? { label: "سقف خروج المال غير محدد — لا يُعتمد قبل فتح الشاشة الكاملة" }
      : cashOutCap === "0.00"
        ? { label: "لا مال يخرج عند الاعتماد؛ يُعكس أثر البيع والذمة فقط", unitPrice: cashOutCap }
        : { label: "أقصى رد مالي محتمل عند الاعتماد", unitPrice: cashOutCap },
    {
      label: `أنشأ الفاتورة: ${args.invoice.createdByName?.trim() || "غير معروف"}`,
      ...(createdAt ? { timestamp: createdAt } : {}),
    },
  ];

  return { amount, cashOutCap, trigger, summaryItems };
}
