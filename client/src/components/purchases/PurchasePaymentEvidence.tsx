import React from "react";
import { Link } from "wouter";
import {
  purchasePaymentReceiptLabel,
  purchasePaymentSourceLabel,
  type PurchasePaymentReceiptEvidence,
} from "@shared/purchasePaymentEvidence";
import {
  purchaseTenderLabel,
  type PurchaseTenderInput,
} from "@shared/purchaseTender";
import { fmtAr } from "@/lib/money";
import type { MetaSection } from "@/lib/printing/docHtml";

interface PaymentEvidenceInput {
  tender?: PurchaseTenderInput | null;
  paymentReceipts?: readonly PurchasePaymentReceiptEvidence[];
}
export function purchasePaymentEvidenceFields({
  tender,
  paymentReceipts = [],
}: PaymentEvidenceInput) {
  return [
    ...(tender
      ? [{ label: "المصدر المحدد", value: purchaseTenderLabel(tender) }]
      : []),
    ...paymentReceipts.map((row) => ({
      label: purchasePaymentReceiptLabel(row),
      value: `${purchasePaymentSourceLabel(row)}؛ ${row.allocatedAmount != null ? `المخصص لهذه الفاتورة ${fmtAr(row.allocatedAmount)} د.ع من أصل سند ${fmtAr(row.amount)} د.ع` : `${fmtAr(row.amount)} د.ع`}${row.referenceNumber ? `؛ المرجع ${row.referenceNumber}` : ""}`,
    })),
    ...(!paymentReceipts.length
      ? [
          {
            label: "السداد الفعلي",
            value: "لا توجد سندات سداد منفذة مرتبطة بدليل هذه الفاتورة",
          },
        ]
      : []),
  ];
}
export function purchasePaymentEvidencePrintMeta(
  input: PaymentEvidenceInput,
): MetaSection[] {
  return [
    {
      title: "مصدر السداد وسنداته",
      fields: purchasePaymentEvidenceFields(input),
    },
  ];
}
export function purchasePaymentEvidencePrintText(
  input: PaymentEvidenceInput,
): string {
  return purchasePaymentEvidenceFields(input)
    .map((field) => `${field.label}: ${field.value}`)
    .join("؛ ");
}
export function PurchasePaymentEvidence({
  tender,
  paymentReceipts = [],
}: PaymentEvidenceInput) {
  return (
    <section
      className="space-y-2 rounded-md border bg-card p-3 text-xs"
      aria-label="دليل سداد فاتورة الشراء"
    >
      {tender ? (
        <p>
          <span className="text-muted-foreground">المصدر المحدد: </span>
          {purchaseTenderLabel(tender)}
        </p>
      ) : null}
      <div className="font-semibold">السداد الفعلي المرتبط بالفاتورة</div>
      {paymentReceipts.length ? (
        <ul className="space-y-2">
          {paymentReceipts.map((row) => (
            <li key={row.id} className="space-y-1 border-t pt-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link
                  href={`/treasury?tab=vouchers&voucherId=${row.id}`}
                  className="font-semibold text-primary underline"
                >
                  {purchasePaymentReceiptLabel(row)}
                </Link>
                <span>{purchasePaymentSourceLabel(row)}</span>
                <span>
                  {row.allocatedAmount != null
                    ? `المخصص لهذه الفاتورة: ${fmtAr(row.allocatedAmount)} د.ع`
                    : `${fmtAr(row.amount)} د.ع`}
                </span>
              </div>
              {row.allocatedAmount != null ? (
                <p className="text-muted-foreground">
                  أصل السند: {fmtAr(row.amount)} د.ع؛ المعروض لهذه الفاتورة هو
                  المبلغ المخصص فقط.
                </p>
              ) : null}
              {row.referenceNumber ? (
                <p className="break-all text-muted-foreground">
                  المرجع: {row.referenceNumber}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          لا توجد سندات سداد منفذة مرتبطة بدليل هذه الفاتورة.
        </p>
      )}
      <p className="text-muted-foreground">
        المصدر المحدد نية سداد؛ السندات أعلاه تبين المصدر الفعلي. السند المعكوس
        معروض ضمن سجل الحركة.
      </p>
    </section>
  );
}
