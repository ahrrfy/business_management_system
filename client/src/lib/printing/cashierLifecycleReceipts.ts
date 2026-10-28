import type { BarcodeSet } from "@shared/barcodeTypes";
import { D } from "@/lib/money";
import { fmtDate } from "../date";
import { paymentMethodLabel } from "../paymentMethod";
import { fmt } from "./brand";
import {
  printDoc,
  type PrintDoc,
  type PrintResult,
  type PrintWindowOptions,
} from "./print";
import {
  preopenShippingLabelWindow,
  printShippingLabel,
  resolveShippingLabelPaymentState,
  type ShippingLabelData,
  type ShippingLabelItem,
} from "./shippingLabel";
import { formatArabicMoneyWords } from "./tafqit";

function safeCode128(ref: string | null | undefined, displayLabel: string): BarcodeSet | undefined {
  const clean = (ref ?? "").trim();
  if (!clean || !/^[\x20-\x7E]+$/.test(clean)) return undefined;
  return {
    barcode128: clean,
    qrPayload: "",
    displayLabel,
  };
}

function stamp(d?: Date | string | null): string {
  return fmtDate(d ?? new Date());
}

function moneyText(v: string | number | null | undefined): string {
  return `${fmt(D(v ?? 0).toFixed(2))} د.ع`;
}

export interface DeliveryFeePaymentReceiptData {
  voucherNumber?: string | null;
  partyName: string;
  amount: string | number;
  paymentMethod?: string | null;
  consignmentNumbers?: string[];
  branchName?: string | null;
  cashierName?: string | null;
  shiftId?: number | string | null;
  notes?: string | null;
  paidAt?: Date | string | null;
}

export function buildDeliveryFeePaymentDoc(data: DeliveryFeePaymentReceiptData): PrintDoc {
  const amt = D(data.amount ?? 0).toFixed(2);
  const ref = data.voucherNumber?.trim() || null;
  const parcels = (data.consignmentNumbers ?? []).filter(Boolean);
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: "سند صرف أجور التوصيل",
    subtitle: ref ? `رقم السند: ${ref}` : data.partyName,
    meta: [
      ref ? `رقم السند: ${ref}` : "",
      `جهة التوصيل: ${data.partyName}`,
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.shiftId != null ? `الوردية: ${data.shiftId}` : "",
      data.cashierName ? `أمين الصندوق: ${data.cashierName}` : "",
      data.paymentMethod ? `طريقة الصرف: ${paymentMethodLabel(data.paymentMethod)}` : "",
      `تاريخ الصرف: ${stamp(data.paidAt)}`,
      data.notes?.trim() ? `ملاحظات: ${data.notes.trim()}` : "",
    ].filter(Boolean),
    ...(parcels.length
      ? {
          columns: ["الإرسالية المشمولة", "الحالة"],
          rows: parcels.map((cn) => [cn, "مشمولة بالصرف"]),
        }
      : {}),
    totals: [
      ...(parcels.length ? [{ label: "عدد الطرود المشمولة", value: String(parcels.length) }] : []),
      { label: "تفقيط المبلغ", value: formatArabicMoneyWords(amt) },
      { label: "صافي الأجور المصروفة", value: moneyText(amt) },
    ],
    footer:
      "أقر أنا ممثل جهة التوصيل باستلام مبلغ الأجور أعلاه كاملاً.\n" +
      "المستلم: ___________________   التوقيع: ___________________",
    barcodeSet: safeCode128(ref, ref ? `سند صرف أجور ${ref}` : ""),
  };
}

export function printDeliveryFeePaymentReceipt(
  data: DeliveryFeePaymentReceiptData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildDeliveryFeePaymentDoc(data), options);
}

export interface ShortfallSettlementVoucherData {
  kind?: "SETTLE_SHORTFALL" | "RECOVER_WRITEOFF";
  voucherNumber?: string | null;
  partyName: string;
  amount: string | number;
  actionType?: string | null;
  paymentMethod?: string | null;
  branchName?: string | null;
  cashierName?: string | null;
  shiftId?: number | string | null;
  reason?: string | null;
  createdAt?: Date | string | null;
}

export function buildShortfallSettlementDoc(data: ShortfallSettlementVoucherData): PrintDoc {
  const amt = D(data.amount ?? 0).toFixed(2);
  const isRecover = data.kind === "RECOVER_WRITEOFF";
  const ref = data.voucherNumber?.trim() || null;
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: isRecover ? "سند تحصيل دين توصيل معدوم" : "سند تسوية عجز المندوب",
    subtitle: ref ? `رقم السند: ${ref}` : data.partyName,
    meta: [
      ref ? `رقم السند: ${ref}` : "",
      `جهة التوصيل: ${data.partyName}`,
      data.actionType ? `نوع التسوية: ${data.actionType}` : "",
      data.paymentMethod ? `طريقة الدفع: ${paymentMethodLabel(data.paymentMethod)}` : "",
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.shiftId != null ? `الوردية: ${data.shiftId}` : "",
      data.cashierName ? `أمين الصندوق: ${data.cashierName}` : "",
      `التاريخ: ${stamp(data.createdAt)}`,
      data.reason?.trim() ? `البيان: ${data.reason.trim()}` : "",
    ].filter(Boolean),
    totals: [
      { label: "تفقيط المبلغ", value: formatArabicMoneyWords(amt) },
      {
        label: isRecover ? "المبلغ المسترد للخزينة" : "مبلغ تسوية العجز",
        value: moneyText(amt),
      },
    ],
    footer: "سند مالي مثبت على دفتر ذمم التوصيل.\nتوقيع المندوب: ________________   توقيع الكاشير: ________________",
    barcodeSet: safeCode128(ref, ref ? `سند تسوية ${ref}` : ""),
  };
}

export function printShortfallSettlementVoucher(
  data: ShortfallSettlementVoucherData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildShortfallSettlementDoc(data), options);
}

export interface DeliveryFeeRefundReceiptData {
  refundNumber?: string | null;
  sourceRef: string;
  customerName?: string | null;
  customerPhone?: string | null;
  amount: string | number;
  paymentMethod?: string | null;
  branchName?: string | null;
  cashierName?: string | null;
  reason?: string | null;
  refundedAt?: Date | string | null;
}

export function buildDeliveryFeeRefundDoc(data: DeliveryFeeRefundReceiptData): PrintDoc {
  const amt = D(data.amount ?? 0).toFixed(2);
  const code = data.refundNumber?.trim() || data.sourceRef.trim();
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: "إيصال رد أمانة / أجرة توصيل",
    subtitle: data.refundNumber ? `رقم السند: ${data.refundNumber}` : `المصدر: ${data.sourceRef}`,
    meta: [
      data.refundNumber ? `رقم السند: ${data.refundNumber}` : "",
      `المرجع الأصلي: ${data.sourceRef}`,
      data.customerName ? `المستفيد: ${data.customerName}` : "",
      data.customerPhone ? `هاتف المستفيد: ${data.customerPhone}` : "",
      data.paymentMethod ? `طريقة الاسترداد: ${paymentMethodLabel(data.paymentMethod)}` : "",
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.cashierName ? `الكاشير: ${data.cashierName}` : "",
      `تاريخ الرد: ${stamp(data.refundedAt)}`,
      data.reason?.trim() ? `السبب: ${data.reason.trim()}` : "",
    ].filter(Boolean),
    totals: [
      { label: "تفقيط المبلغ", value: formatArabicMoneyWords(amt) },
      { label: "المبلغ المسترد", value: moneyText(amt) },
    ],
    footer: "يثبت هذا الإيصال رد أمانة / أجرة التوصيل للمستفيد.\nتوقيع المستلم: ________________________",
    barcodeSet: safeCode128(code, `رد أجرة توصيل — ${code}`),
  };
}

export function printDeliveryFeeRefundReceipt(
  data: DeliveryFeeRefundReceiptData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildDeliveryFeeRefundDoc(data), options);
}

export interface OverageRefundReceiptData {
  refundNumber?: string | null;
  sourceRef: string;
  beneficiaryName?: string | null;
  beneficiaryRole?: "CUSTOMER" | "CARRIER" | string | null;
  amount: string | number;
  paymentMethod?: string | null;
  branchName?: string | null;
  cashierName?: string | null;
  notes?: string | null;
  refundedAt?: Date | string | null;
}

export function buildOverageRefundDoc(data: OverageRefundReceiptData): PrintDoc {
  const amt = D(data.amount ?? 0).toFixed(2);
  const code = data.refundNumber?.trim() || data.sourceRef.trim();
  const roleLabel =
    data.beneficiaryRole === "CARRIER"
      ? "ناقل / مندوب توصيل"
      : data.beneficiaryRole === "CUSTOMER"
        ? "عميل"
        : data.beneficiaryRole ?? "";
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: "إيصال رد فائض تحصيل / رسوم",
    subtitle: data.refundNumber ? `رقم السند: ${data.refundNumber}` : `المصدر: ${data.sourceRef}`,
    meta: [
      data.refundNumber ? `رقم السند: ${data.refundNumber}` : "",
      `المرجع: ${data.sourceRef}`,
      data.beneficiaryName ? `المستفيد: ${data.beneficiaryName}` : "",
      roleLabel ? `صفة المستفيد: ${roleLabel}` : "",
      data.paymentMethod ? `طريقة الاسترداد: ${paymentMethodLabel(data.paymentMethod)}` : "",
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.cashierName ? `الكاشير: ${data.cashierName}` : "",
      `التاريخ: ${stamp(data.refundedAt)}`,
      data.notes?.trim() ? `ملاحظات: ${data.notes.trim()}` : "",
    ].filter(Boolean),
    totals: [
      { label: "تفقيط المبلغ", value: formatArabicMoneyWords(amt) },
      { label: "صافي الفائض المردود", value: moneyText(amt) },
    ],
    footer: "إيصال صرف حقوق / فائض تحصيل معتمد.\nتوقيع المستلم: ________________________",
    barcodeSet: safeCode128(code, `رد فائض — ${code}`),
  };
}

export function printOverageRefundReceipt(
  data: OverageRefundReceiptData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildOverageRefundDoc(data), options);
}

export interface AssignmentCancelReceiptData {
  action?: "cancelAssignment" | "declareReturn";
  consignmentNumber: string;
  sourceRef?: string | null;
  partyName?: string | null;
  recipientName?: string | null;
  codAmount?: string | number | null;
  reason: string;
  branchName?: string | null;
  cashierName?: string | null;
  occurredAt?: Date | string | null;
}

export function buildAssignmentCancelDoc(data: AssignmentCancelReceiptData): PrintDoc {
  const isDeclare = data.action === "declareReturn";
  const cod = D(data.codAmount ?? 0).toFixed(2);
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: isDeclare ? "محضر إعلان رجوع شحنة" : "محضر إلغاء إسناد شحنة",
    subtitle: data.consignmentNumber,
    meta: [
      `رقم الإرسالية: ${data.consignmentNumber}`,
      data.sourceRef ? `المصدر: ${data.sourceRef}` : "",
      data.partyName ? `جهة التوصيل: ${data.partyName}` : "",
      data.recipientName ? `المستلم: ${data.recipientName}` : "",
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.cashierName ? `الموظف: ${data.cashierName}` : "",
      `الوقت: ${stamp(data.occurredAt)}`,
      `السبب: ${data.reason.trim()}`,
    ].filter(Boolean),
    totals: [
      {
        label: isDeclare ? "مطالبة الطرد قيد الرجوع" : "مطالبة الإسناد الملغى",
        value: moneyText(cod),
      },
    ],
    footer: isDeclare
      ? "يثبت إعلان رجوع الطرد بانتظار الاستلام والفحص المادي في محطة المرتجع."
      : "يثبت إلغاء إسناد الطرد وعودته لعهدة الفرع؛ لا يلغي الفاتورة ولا يرد نقداً للعميل.",
    barcodeSet: safeCode128(data.consignmentNumber, `الإرسالية ${data.consignmentNumber}`),
  };
}

export function printAssignmentCancelReceipt(
  data: AssignmentCancelReceiptData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildAssignmentCancelDoc(data), options);
}

export interface OrderCancellationReceiptData {
  documentNumber: string;
  orderKind?: "INVOICE" | "WORK_ORDER" | "ONLINE_ORDER" | string;
  customerName?: string | null;
  customerPhone?: string | null;
  originalTotal?: string | number | null;
  refundedAmount?: string | number | null;
  refundMethod?: string | null;
  reason?: string | null;
  branchName?: string | null;
  cashierName?: string | null;
  cancelledAt?: Date | string | null;
}

export function buildOrderCancellationDoc(data: OrderCancellationReceiptData): PrintDoc {
  const refunded = D(data.refundedAmount ?? 0).toFixed(2);
  const hasCashRefund = D(refunded).gt(0);
  const orig = data.originalTotal != null ? D(data.originalTotal).toFixed(2) : null;
  const kindLabel =
    data.orderKind === "WORK_ORDER"
      ? "أمر عمل"
      : data.orderKind === "ONLINE_ORDER"
        ? "طلب متجر إلكتروني"
        : "فاتورة مبيعات";
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: "إيصال إلغاء واسترداد مستحقات",
    subtitle: `${kindLabel} — ${data.documentNumber}`,
    meta: [
      `رقم المستند: ${data.documentNumber}`,
      `نوع المستند: ${kindLabel}`,
      data.customerName ? `العميل: ${data.customerName}` : "",
      data.customerPhone ? `هاتف العميل: ${data.customerPhone}` : "",
      data.refundMethod ? `طريقة الاسترداد: ${paymentMethodLabel(data.refundMethod)}` : "",
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.cashierName ? `الكاشير: ${data.cashierName}` : "",
      `وقت الإلغاء: ${stamp(data.cancelledAt)}`,
      data.reason?.trim() ? `سبب الإلغاء: ${data.reason.trim()}` : "",
    ].filter(Boolean),
    totals: [
      ...(orig != null ? [{ label: "قيمة المستند الملغى", value: moneyText(orig) }] : []),
      ...(hasCashRefund ? [{ label: "تفقيط المسترد", value: formatArabicMoneyWords(refunded) }] : []),
      { label: "المبلغ المسترد للعميل", value: moneyText(refunded) },
    ],
    footer: "تم إلغاء المستند أصولياً وتسوية أثره المالي والمخزني.\nتوقيع المستلم: ________________________",
    barcodeSet: safeCode128(data.documentNumber, `إلغاء ${data.documentNumber}`),
  };
}

export function printOrderCancellationReceipt(
  data: OrderCancellationReceiptData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildOrderCancellationDoc(data), options);
}

export interface InvoicePaymentReceiptData {
  receiptNumber?: string | null;
  invoiceNumber: string;
  customerName?: string | null;
  customerPhone?: string | null;
  invoiceTotal?: string | number | null;
  paidBefore?: string | number | null;
  amountPaid: string | number;
  remainingAfter?: string | number | null;
  paymentMethod?: string | null;
  reference?: string | null;
  branchName?: string | null;
  cashierName?: string | null;
  paidAt?: Date | string | null;
}

export function buildInvoicePaymentDoc(data: InvoicePaymentReceiptData): PrintDoc {
  const paid = D(data.amountPaid ?? 0).toFixed(2);
  const code = data.receiptNumber?.trim() || data.invoiceNumber.trim();
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: "إيصال قبض دفعة فاتورة",
    subtitle: `فاتورة ${data.invoiceNumber}`,
    meta: [
      data.receiptNumber ? `رقم إيصال القبض: ${data.receiptNumber}` : "",
      `رقم الفاتورة: ${data.invoiceNumber}`,
      data.customerName ? `العميل: ${data.customerName}` : "",
      data.customerPhone ? `هاتف العميل: ${data.customerPhone}` : "",
      data.paymentMethod ? `طريقة الدفع: ${paymentMethodLabel(data.paymentMethod)}` : "",
      data.reference?.trim() ? `مرجع الحركة: ${data.reference.trim()}` : "",
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.cashierName ? `الكاشير: ${data.cashierName}` : "",
      `وقت القبض: ${stamp(data.paidAt)}`,
    ].filter(Boolean),
    totals: [
      ...(data.invoiceTotal != null
        ? [{ label: "إجمالي الفاتورة", value: moneyText(data.invoiceTotal) }]
        : []),
      ...(data.paidBefore != null
        ? [{ label: "المدفوع سابقاً", value: moneyText(data.paidBefore) }]
        : []),
      ...(data.remainingAfter != null
        ? [{ label: "المتبقي بعد الدفعة", value: moneyText(data.remainingAfter) }]
        : []),
      { label: "تفقيط الدفعة", value: formatArabicMoneyWords(paid) },
      { label: "المبلغ المقبوض الآن", value: moneyText(paid) },
    ],
    footer: "شكراً لتعاملكم مع المكتبة العربية.",
    barcodeSet: safeCode128(code, `قبض فاتورة ${data.invoiceNumber}`),
  };
}

export function printInvoicePaymentReceipt(
  data: InvoicePaymentReceiptData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildInvoicePaymentDoc(data), options);
}

export interface CashDropReceiptData {
  dropNumber?: string | null;
  shiftId: number | string;
  amount: string | number;
  destinationLabel?: string | null;
  branchName?: string | null;
  cashierName?: string | null;
  reason?: string | null;
  createdAt?: Date | string | null;
}

export function buildCashDropDoc(data: CashDropReceiptData): PrintDoc {
  const amt = D(data.amount ?? 0).toFixed(2);
  const code = data.dropNumber?.trim() || `SHF-${data.shiftId}`;
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: "قسيمة سحب نقدي من الدرج",
    subtitle: data.dropNumber ? `رقم القسيمة: ${data.dropNumber}` : `وردية #${data.shiftId}`,
    meta: [
      data.dropNumber ? `رقم القسيمة: ${data.dropNumber}` : "",
      `رقم الوردية: ${data.shiftId}`,
      data.destinationLabel ? `الوجهة: ${data.destinationLabel}` : "",
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.cashierName ? `الكاشير المسلم: ${data.cashierName}` : "",
      `وقت السحب: ${stamp(data.createdAt)}`,
      data.reason?.trim() ? `البيان: ${data.reason.trim()}` : "",
    ].filter(Boolean),
    totals: [
      { label: "تفقيط المبلغ", value: formatArabicMoneyWords(amt) },
      { label: "المبلغ المسحوب من الدرج", value: moneyText(amt) },
    ],
    footer: "توضع نسخة مع النقد المسحوب للخزينة.\nتوقيع الكاشير: ____________   توقيع المستلم: ____________",
    barcodeSet: safeCode128(code, `سحب نقدي — ${code}`),
  };
}

export function printCashDropReceipt(
  data: CashDropReceiptData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildCashDropDoc(data), options);
}

export interface DrawerExpenseReceiptData {
  expenseNumber: string;
  categoryName?: string | null;
  payeeName?: string | null;
  amount: string | number;
  paymentMethod?: string | null;
  shiftId?: number | string | null;
  branchName?: string | null;
  cashierName?: string | null;
  description?: string | null;
  createdAt?: Date | string | null;
}

export function buildDrawerExpenseDoc(data: DrawerExpenseReceiptData): PrintDoc {
  const amt = D(data.amount ?? 0).toFixed(2);
  return {
    kind: "receipt",
    includeBrandHeader: true,
    title: "سند صرف مصروف من الدرج",
    subtitle: `سند رقم ${data.expenseNumber}`,
    meta: [
      `رقم السند: ${data.expenseNumber}`,
      data.categoryName ? `بند المصروف: ${data.categoryName}` : "",
      data.payeeName ? `المستفيد: ${data.payeeName}` : "",
      data.paymentMethod ? `طريقة الصرف: ${paymentMethodLabel(data.paymentMethod)}` : "",
      data.shiftId != null ? `الوردية: ${data.shiftId}` : "",
      data.branchName ? `الفرع: ${data.branchName}` : "",
      data.cashierName ? `الكاشير: ${data.cashierName}` : "",
      `التاريخ: ${stamp(data.createdAt)}`,
      data.description?.trim() ? `البيان: ${data.description.trim()}` : "",
    ].filter(Boolean),
    totals: [
      { label: "تفقيط المبلغ", value: formatArabicMoneyWords(amt) },
      { label: "مبلغ المصروف", value: moneyText(amt) },
    ],
    footer: "سند صرف معتمد من عهدة الدرج.\nتوقيع المستلم: ________________   توقيع الكاشير: ________________",
    barcodeSet: safeCode128(data.expenseNumber, `مصروف ${data.expenseNumber}`),
  };
}

export function printDrawerExpenseReceipt(
  data: DrawerExpenseReceiptData,
  options?: PrintWindowOptions,
): Promise<PrintResult> {
  return printDoc(buildDrawerExpenseDoc(data), options);
}

export interface AftercarePrepareLabelInput {
  executionId: number | string;
  caseNumber?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  governorate?: string | null;
  addressText?: string | null;
  notes?: string | null;
  items?: ShippingLabelItem[];
  createdAt?: Date | string | null;
  isReprint?: boolean;
}

export function printAftercarePrepareLabel(
  input: AftercarePrepareLabelInput,
  options?: PrintWindowOptions,
) {
  const ref = `AE-${input.executionId}`;
  const items: ShippingLabelItem[] =
    input.items && input.items.length > 0
      ? input.items
      : [
          {
            productName: input.caseNumber
              ? `دفعة معالجة / تعويض (${input.caseNumber})`
              : `دفعة معالجة / تعويض (${ref})`,
            unitName: "",
            quantity: "1",
          },
        ];
  return printShippingLabel(
    {
      orderNumber: ref,
      barcodeValue: ref,
      customerName: input.customerName ?? null,
      customerPhone: input.customerPhone ?? null,
      governorate: input.governorate ?? null,
      addressText: input.addressText ?? null,
      total: "0.00",
      paymentState: "PREPAID",
      notes:
        input.notes?.trim() ||
        "ملصق تجهيز معالجة / تعويض — لا يحصل أي مبلغ من العميل",
      createdAt: input.createdAt ?? new Date(),
      printedAt: new Date(),
      isReprint: input.isReprint,
      items,
    },
    options,
  );
}


export interface PosDeliveryLabelReceiptLike {
  invoiceNumber: string;
  invoiceId: number;
  customerName?: string | null;
  customerPhone?: string | null;
  total: number;
  received: number;
  lines: Array<{ name: string; unit: string; qty: number }>;
  delivery?: {
    partyName: string;
    fee: string;
    feeCollection: "COURIER" | "COUNTER" | "SHOP";
    address?: string | null;
    governorate?: string | null;
    recipientName?: string | null;
    recipientPhone?: string | null;
    externalTrackingRef?: string | null;
  } | null;
  consignmentNumber?: string | null;
}

export function buildPosDeliveryShippingLabelData(
  rec: PosDeliveryLabelReceiptLike,
  isReprint = false,
): ShippingLabelData {
  const remainingGoods = D(rec.total).minus(D(rec.received));
  const goodsDue = remainingGoods.gt(0) ? remainingGoods : D(0);
  const courierFee = rec.delivery?.feeCollection === "COURIER" ? D(rec.delivery.fee ?? 0) : D(0);
  const codTotal = goodsDue.plus(courierFee);
  const orderNum = rec.consignmentNumber || rec.invoiceNumber;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return {
    orderNumber: orderNum,
    barcodeValue: orderNum,
    customerName: rec.delivery?.recipientName || rec.customerName || null,
    customerPhone: rec.delivery?.recipientPhone || rec.customerPhone || null,
    governorate: rec.delivery?.governorate ?? null,
    addressText: rec.delivery?.address ?? null,
    total: codTotal.toFixed(2),
    subtotal: D(rec.total).toFixed(2),
    paidAmount: D(rec.received).gt(0) ? D(rec.received).toFixed(2) : null,
    shippingFee: courierFee.gt(0) ? courierFee.toFixed(2) : null,
    paymentState: resolveShippingLabelPaymentState(codTotal.toNumber()),
    deliveryPartyName: rec.delivery?.partyName ?? null,
    externalTrackingRef: rec.delivery?.externalTrackingRef ?? null,
    qrUrl: orderNum && origin ? `${origin}/verify?ref=${encodeURIComponent(orderNum)}` : null,
    isReprint,
    items: rec.lines.map((l) => ({
      productName: l.name,
      unitName: l.unit,
      quantity: String(l.qty),
    })),
  };
}

export async function printPosDeliveryShippingLabel(
  rec: PosDeliveryLabelReceiptLike,
  printAuthorizedDocument: (
    invoiceId: number,
    purpose: "SHIPPING_LABEL",
    reprint: boolean,
    render: () => Promise<PrintResult>,
  ) => Promise<{ ok: boolean; via: string }>,
  intoWin?: Window | null,
  reprint = false,
): Promise<void> {
  if (!rec.delivery && !rec.consignmentNumber) {
    try { intoWin?.close(); } catch { /* noop */ }
    return;
  }
  const win = intoWin ?? preopenShippingLabelWindow();
  let enteredRender = false;
  try {
    const authRes = await printAuthorizedDocument(rec.invoiceId ?? 0, "SHIPPING_LABEL", reprint, async () => {
      enteredRender = true;
      const res = await printShippingLabel(buildPosDeliveryShippingLabelData(rec, reprint), { into: win });
      return res.ok
        ? { ok: true as const, via: "browser" as const }
        : { ok: false as const, via: "browser" as const, reason: "popup-blocked" as const };
    });
    if (!enteredRender && !authRes.ok) {
      try { win?.close(); } catch { /* noop */ }
    }
  } catch (err) {
    if (!enteredRender) {
      try { win?.close(); } catch { /* noop */ }
    }
    throw err;
  }
}
