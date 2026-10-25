import { fmt } from "@/lib/money";
import { printDoc, type PrintDoc } from "@/lib/printing/print";
import {
  createDeliveryDocumentSnapshot,
  deliveryDocumentAuditLines,
  type DeliveryDocumentAudit,
} from "@/lib/printing/deliveryDocumentSnapshot";

export interface RemittanceAllocationPrintRow {
  readonly consignmentNumber?: string | null;
  readonly invoiceNumber?: string | null;
  readonly orderNumber?: string | null;
  readonly recipientName?: string | null;
  readonly recipientPhone?: string | null;
  readonly grossApplied?: string | null;
  readonly feeOffset?: string | null;
  readonly cashReceived?: string | null;
  readonly paymentMethod?: string | null;
}

export interface RemittanceReceiptData extends DeliveryDocumentAudit {
  readonly remittanceNumber: string | null;
  readonly collectedTotal: string;
  readonly feesTotal: string;
  readonly netRemitted: string;
  readonly shortfallTotal: string;
  readonly courierCommissionAmount?: string | null;
  readonly cashReceived?: string | null;
  readonly receivedAt?: Date | string | null;
  readonly branchName?: string | null;
  readonly branchId?: number | null;
  readonly shiftId?: number | null;
  readonly cashierName?: string | null;
  readonly receivedByName?: string | null;
  readonly paymentMethod?: string | null;
  readonly cashBucket?: string | null;
  readonly allocations?: readonly RemittanceAllocationPrintRow[];
}

/** يبني إيصالاً من لقطة التوريد الممرّرة فقط؛ لا يعيد قراءة قيم حية عند إعادة الطباعة. */
export function buildRemittanceReceiptDoc(
  partyName: string,
  r: RemittanceReceiptData,
  now = new Date(),
): PrintDoc | null {
  if (!r.remittanceNumber) return null;
  const snapshot = createDeliveryDocumentSnapshot({
    documentType: "REMITTANCE_RECEIPT",
    payload: r,
    audit: {
      eventAt: r.receivedAt ?? r.eventAt,
      printedAt: r.printedAt,
      copy: r.copy,
    },
    now,
  });
  const actualCash = r.cashReceived ?? r.netRemitted;
  const totals: Array<{ label: string; value: string }> = [
    { label: "إجمالي تحصيل العميل المسوّى", value: `${fmt(r.collectedTotal)} د.ع` },
    { label: "النقد المستلم فعلياً", value: `${fmt(actualCash)} د.ع` },
    { label: "مستحق جهة التوصيل", value: `${fmt(r.feesTotal)} د.ع` },
  ];
  if (r.courierCommissionAmount != null) {
    totals.push({
      label: "عمولة العقد المحسوبة",
      value: `${fmt(r.courierCommissionAmount)} د.ع`,
    });
  }
  totals.push(
    { label: "صافي التوريد للمكتبة", value: `${fmt(r.netRemitted)} د.ع` },
    { label: "عجز باقٍ في عهدة الجهة", value: `${fmt(r.shortfallTotal)} د.ع` },
  );

  const allocations = r.allocations ?? [];
  return {
    kind: "zreport",
    title: "إيصال توريد جهة التوصيل",
    subtitle: r.remittanceNumber,
    meta: [
      `جهة التوصيل: ${partyName}`,
      r.branchName
        ? `الفرع: ${r.branchName}`
        : r.branchId != null
          ? `الفرع: #${r.branchId}`
          : "",
      r.shiftId != null ? `الوردية: #${r.shiftId}` : "",
      r.cashierName || r.receivedByName
        ? `الموظف المستلم: ${r.cashierName ?? r.receivedByName}`
        : "",
      r.paymentMethod ? `طريقة الدفع: ${r.paymentMethod}` : "",
      r.cashBucket ? `وجهة النقد: ${r.cashBucket}` : "",
      ...deliveryDocumentAuditLines("وقت التوريد", snapshot),
    ].filter(Boolean),
    ...(allocations.length > 0
      ? {
          columns: ["تخصيص الإرسالية", "المبالغ"],
          itemBlocks: allocations.map((line) => ({
            name: [
              line.consignmentNumber || "إرسالية بلا رقم",
              line.invoiceNumber
                ? `فاتورة ${line.invoiceNumber}`
                : line.orderNumber
                  ? `طلب ${line.orderNumber}`
                  : null,
              line.recipientName || null,
            ].filter(Boolean).join(" · "),
            quantityPrice: [
              line.recipientPhone ? `هاتف ${line.recipientPhone}` : null,
              line.paymentMethod ? `دفع ${line.paymentMethod}` : null,
              line.feeOffset != null ? `أجرة ${fmt(line.feeOffset)}` : null,
            ].filter(Boolean).join(" · ") || "تخصيص مالي",
            total: [
              `مخصص ${fmt(line.grossApplied ?? "0")}`,
              `نقد ${fmt(line.cashReceived ?? "0")}`,
            ].join("\n"),
          })),
        }
      : {
          columns: ["بيان التوريد", "القيمة"],
          rows: [
            ["إجمالي التسوية", `${fmt(r.collectedTotal)} د.ع`],
            ["النقد المستلم", `${fmt(actualCash)} د.ع`],
            ["مستحق الجهة", `${fmt(r.feesTotal)} د.ع`],
            ["العجز", `${fmt(r.shortfallTotal)} د.ع`],
          ],
        }),
    totals,
    // لا QR: لا يوجد في التطبيق مسار تحقق عام مثبت لسند التوريد.
    barcodeSet: {
      qrPayload: "",
      barcode128: r.remittanceNumber,
      displayLabel: `سند توريد: ${r.remittanceNumber}\nجهة التوصيل: ${partyName}`,
    },
    footer:
      "هذا السند يثبت نقل عهدة النقد إلى المكتبة، ولا يمثل تحصيلاً جديداً من العميل.\nتوقيع جهة التوصيل: ____________  توقيع المستلم: ____________",
  };
}

export function printRemittanceReceipt(
  partyName: string,
  r: RemittanceReceiptData,
): void {
  const doc = buildRemittanceReceiptDoc(partyName, r);
  if (!doc) return;
  void printDoc(doc).catch((error) => {
    console.warn("[delivery-remittance] فشلت الطباعة بعد ثبوت التوريد:", error);
  });
}
