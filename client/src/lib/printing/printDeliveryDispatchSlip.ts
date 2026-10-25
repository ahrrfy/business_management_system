import {
  deliverySourceView,
  type DeliverySourceReference,
} from "@shared/deliverySource";
import { CO, fmt } from "./brand";
import { printDoc, type PrintDoc, type PrintResult } from "./print";
import {
  createDeliveryDocumentSnapshot,
  deliveryDocumentAuditLines,
  type DeliveryDocumentAudit,
} from "./deliveryDocumentSnapshot";

export interface DispatchSlipData
  extends DeliverySourceReference, DeliveryDocumentAudit {
  consignmentNumber: string;
  orderNumber: string;
  orderKind?:
    | "workOrder"
    | "invoice"
    | "onlineOrder"
    | "fulfillmentRequest"
    | "aftercare";
  partyName: string;
  recipientName: string;
  recipientPhone: string;
  deliveryAddress: string;
  governorate?: string | null;
  /** قد تغيب عن اللقطة التاريخية القديمة؛ لا تُستبدل بقيمة حية. */
  salePrice: string | null;
  deposit?: string | null;
  codAmount: string | null;
  deliveryFee?: string | null;
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  title?: string | null;
  items?:
    | readonly {
        name?: string | null;
        productName?: string | null;
        title?: string | null;
        quantity?: number | string | null;
        price?: number | string | null;
        unitPrice?: number | string | null;
        total?: number | string | null;
      }[]
    | null;
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
    (d.codAmount == null ||
      Number(d.codAmount) !== 0 ||
      d.feeCollection !== "SHOP")
  ) {
    throw new Error("بوليصة المعالجة تتطلب تحصيلاً صفرياً وأجرة على المكتبة");
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
  const hasCod = d.codAmount != null;
  const hasFee = d.deliveryFee != null;
  const codNum = Number(d.codAmount || 0);
  const feeNum = Number(d.deliveryFee || 0);
  const courierFee = d.feeCollection === "COURIER";
  const totalAtDoorKnown = hasCod && (!courierFee || hasFee);
  const totalAtDoor = courierFee ? codNum + feeNum : codNum;
  const feeExplanation =
    d.feeCollection === "SHOP"
      ? "على المكتبة (مجاناً)"
      : d.feeCollection === "COUNTER"
        ? "مقبوضة مسبقاً"
        : d.feeCollection === "COURIER"
          ? "يقبضها المندوب"
          : "جهة التحمل غير متاحة تاريخياً";
  const hasSalePrice = d.salePrice != null;
  const hasDeposit = d.deposit != null;
  const depositNum = Number(d.deposit || 0);
  const isFullyPrepaid =
    hasSalePrice &&
    hasDeposit &&
    hasCod &&
    depositNum >= Number(d.salePrice) &&
    codNum === 0;
  const rows = d.items?.length
    ? d.items.map((item) => {
        const quantity = Number(item.quantity ?? 1);
        return [
          item.title || item.productName || item.name || "بند الطلب",
          String(item.quantity ?? 1),
          item.total != null || item.unitPrice != null || item.price != null
            ? `${fmt(item.total ?? Number(item.unitPrice ?? item.price) * quantity)} د.ع`
            : "غير متاح تاريخياً",
        ];
      })
    : [
        [
          d.title || sourceLabel,
          "1",
          hasSalePrice ? `${fmt(d.salePrice)} د.ع` : "غير متاح تاريخياً",
        ],
      ];

  return {
    kind: "receipt",
    title: aftercare ? "بوليصة استكمال نقص / معالجة" : "بوليصة إسناد وتوصيل",
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
      ...(hasSalePrice
        ? [{ label: "قيمة الطلب", value: `${fmt(d.salePrice!)} د.ع` }]
        : []),
      ...(hasDeposit && depositNum > 0
        ? [
            {
              label: isFullyPrepaid ? "مدفوع مسبقاً بالكامل" : "العربون",
              value: `${fmt(d.deposit!)} د.ع`,
            },
          ]
        : []),
      {
        label: `أجرة التوصيل — ${feeExplanation}`,
        value: hasFee
          ? feeNum > 0
            ? `${fmt(feeNum)} د.ع`
            : "مجاناً"
          : "غير متاحة تاريخياً",
      },
      {
        label:
          isFullyPrepaid && courierFee
            ? "المطلوب تحصيله عند الاستلام (أجرة التوصيل فقط)"
            : "المطلوب تحصيله عند الاستلام",
        value: totalAtDoorKnown
          ? `${fmt(totalAtDoor)} د.ع`
          : "غير متاح تاريخياً",
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
