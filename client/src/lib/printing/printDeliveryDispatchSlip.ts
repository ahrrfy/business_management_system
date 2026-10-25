import { deliverySourceView, type DeliverySourceReference } from "@shared/deliverySource";
import { CO, fmt } from "./brand";
import { printDoc, type PrintDoc, type PrintResult } from "./print";
import {
  createDeliveryDocumentSnapshot,
  deliveryDocumentAuditLines,
  type DeliveryDocumentAudit,
} from "./deliveryDocumentSnapshot";

export interface DispatchSlipData extends DeliverySourceReference, DeliveryDocumentAudit {
  consignmentNumber: string;
  orderNumber: string;
  orderKind?: "workOrder" | "invoice" | "onlineOrder" | "fulfillmentRequest" | "aftercare";
  partyName: string;
  recipientName: string;
  recipientPhone: string;
  deliveryAddress: string;
  governorate?: string | null;
  salePrice: string;
  deposit?: string | null;
  codAmount: string;
  deliveryFee?: string | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP";
  title?: string | null;
  items?: readonly {
    name?: string | null;
    productName?: string | null;
    title?: string | null;
    quantity?: number | string | null;
    price?: number | string | null;
    unitPrice?: number | string | null;
    total?: number | string | null;
  }[] | null;
  notes?: string | null;
  /** وقت الإسناد المثبت في الخادم؛ لا يُستبدل بوقت إعادة الطباعة. */
  dispatchedAt?: Date | string | null;
  /** رابط تحقق عام حقيقي فقط. إن غاب يبقى Code128 بلا QR. */
  qrUrl?: string | null;
}

export function buildDeliveryDispatchSlipDoc(
  d: DispatchSlipData,
  now = new Date(),
): PrintDoc {
  const aftercare =
    d.sourceType === "AFTERCARE_EXECUTION" || d.orderKind === "aftercare";
  if (
    aftercare &&
    (Number(d.codAmount) !== 0 || d.feeCollection !== "SHOP")
  ) {
    throw new Error(
      "بوليصة المعالجة تتطلب تحصيلاً صفرياً وأجرة على المكتبة",
    );
  }

  const snapshot = createDeliveryDocumentSnapshot({
    documentType: "DISPATCH_SLIP",
    payload: d,
    audit: {
      eventAt: d.dispatchedAt ?? d.eventAt,
      printedAt: d.printedAt,
      copy: d.copy,
    },
    now,
  });
  const sourceLabel = aftercare
    ? "دفعة معالجة — لا يُطلب مبلغ من العميل"
    : d.sourceType
      ? deliverySourceView(d).reference
      : `رقم ${d.orderKind === "invoice" ? "الفاتورة" : "الطلب"}: #${d.orderNumber}`;
  const codNum = Number(d.codAmount || 0);
  const feeNum = Number(d.deliveryFee || 0);
  const courierFee = d.feeCollection === "COURIER";
  const totalAtDoor = courierFee ? codNum + feeNum : codNum;
  const feeExplanation =
    d.feeCollection === "SHOP"
      ? "على المكتبة (مجاناً)"
      : d.feeCollection === "COUNTER"
        ? "مقبوضة مسبقاً"
        : "يقبضها المندوب";
  const depositNum = Number(d.deposit || 0);
  const isFullyPrepaid =
    depositNum >= Number(d.salePrice || 0) && codNum === 0;
  const rows = d.items?.length
    ? d.items.map((item) => {
        const quantity = Number(item.quantity ?? 1);
        return [
          item.title || item.productName || item.name || "بند الطلب",
          String(item.quantity ?? 1),
          `${fmt(item.total ?? Number(item.unitPrice ?? item.price ?? 0) * quantity)} د.ع`,
        ];
      })
    : [[d.title || sourceLabel, "1", `${fmt(d.salePrice)} د.ع`]];

  return {
    kind: "receipt",
    title: aftercare
      ? "بوليصة استكمال نقص / معالجة"
      : "بوليصة إسناد وتوصيل",
    subtitle: `${CO.name} — ${CO.sub}`,
    meta: [
      `رقم الإرسالية: ${d.consignmentNumber}`,
      sourceLabel,
      `جهة التوصيل: ${d.partyName}`,
      ...deliveryDocumentAuditLines("وقت الإسناد", snapshot),
      `المستلم: ${d.recipientName || "—"}`,
      `هاتف المستلم: ${d.recipientPhone || "—"}`,
      `العنوان: ${d.deliveryAddress || "غير محدد"}${d.governorate ? ` (${d.governorate})` : ""}`,
      ...(d.notes ? [`ملاحظات: ${d.notes}`] : []),
    ],
    columns: ["البند", "الكمية", "المبلغ"],
    rows,
    totals: [
      { label: "قيمة الطلب", value: `${fmt(d.salePrice)} د.ع` },
      ...(depositNum > 0
        ? [{
            label: isFullyPrepaid ? "مدفوع مسبقاً بالكامل" : "العربون",
            value: `${fmt(d.deposit!)} د.ع`,
          }]
        : []),
      {
        label: `أجرة التوصيل — ${feeExplanation}`,
        value: feeNum > 0 ? `${fmt(feeNum)} د.ع` : "مجاناً",
      },
      {
        label:
          isFullyPrepaid && courierFee
            ? "المطلوب تحصيله عند الاستلام (أجرة التوصيل فقط)"
            : "المطلوب تحصيله عند الاستلام",
        value: `${fmt(totalAtDoor)} د.ع`,
      },
    ],
    footer: aftercare
      ? "لا يطالب العميل بأي مبلغ — أجرة الإعادة على المكتبة\nتوقيع المندوب: ____________  توقيع العميل: ____________"
      : "توقيع واستلام المندوب: ____________  توقيع العميل: ____________\nيرجى التأكد من محتويات الطرد ومطابقة المبلغ قبل الاستلام",
    barcodeSet: {
      barcode128: d.consignmentNumber,
      qrPayload: d.qrUrl?.trim() ?? "",
      displayLabel: `إرسالية: ${d.consignmentNumber}\n${sourceLabel}`,
    },
  };
}

export function printDeliveryDispatchSlip(d: DispatchSlipData): boolean {
  void printDeliveryDispatchSlipAsync(d).catch((error) => {
    console.warn("[dispatch-slip] فشل الطباعة:", error);
  });
  return true;
}

export function printDeliveryDispatchSlipAsync(
  d: DispatchSlipData,
): Promise<PrintResult> {
  return printDoc(buildDeliveryDispatchSlipDoc(d));
}
