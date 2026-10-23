import { D } from "@/lib/money";
import { BRAND as B } from "./brand";
import { totalsBox } from "./docHtml";
import {
  invoicePrintAmounts,
  type InvoicePrintAmountsInput,
} from "./receiptLayoutInvoiceAmounts";

export interface InvoiceTotalsPrintInput extends InvoicePrintAmountsInput {
  subtotal: string | number;
  discountAmount?: string | number | null;
  taxAmount?: string | number | null;
  taxRate?: number | null;
  deliveryFee?: string | number | null;
  deliveryFree?: boolean | null;
  deliveryWaivedAmount?: string | number | null;
  courierDelivery?: {
    partyName: string;
    fee: string | number;
    feeCollection: "COURIER" | "COUNTER" | "SHOP";
  } | null;
}
type MoneyFormat = (value: string | number | null | undefined) => string;
type TaxLabel = (
  amount: string | number | null | undefined,
  rate: number | null | undefined,
  subtotal: string | number,
  discount: string | number | null | undefined,
) => string;

export function salesInvoiceTotals(
  data: InvoiceTotalsPrintInput,
  money: MoneyFormat,
  taxLabel: TaxLabel,
): string {
  const facts = invoicePrintAmounts(data);
  const remaining = D(facts.remainingAmount);
  const returned = D(facts.returnedTotal);
  const after = facts.balanceAfter == null ? null : D(facts.balanceAfter);
  const courier = data.courierDelivery;
  const fee = D(courier?.fee ?? 0);
  const returnedLines =
    returned.gt(0) || !D(facts.currentTotal).eq(D(data.total))
      ? [
          {
            label: "المرتجع",
            value: money(facts.returnedTotal),
            color: B.orange,
          },
          {
            label: "القيمة الحالية للفاتورة",
            value: money(facts.currentTotal),
          },
        ]
      : [];
  return totalsBox({
    lines: [
      { label: "المجموع الفرعي", value: money(data.subtotal) },
      ...(D(data.discountAmount ?? 0).gt(0)
        ? [
            {
              label: "الخصم",
              value: money(data.discountAmount),
              color: B.orange,
              sign: "−" as const,
            },
          ]
        : []),
      ...(D(data.taxAmount ?? 0).gt(0)
        ? [
            {
              label: taxLabel(
                data.taxAmount,
                data.taxRate,
                data.subtotal,
                data.discountAmount,
              ),
              value: money(data.taxAmount),
              sign: "+" as const,
            },
          ]
        : []),
      ...returnedLines,
      ...(D(data.deliveryFee ?? 0).gt(0)
        ? [
            {
              label: "أجرة التوصيل",
              value: money(data.deliveryFee),
              sign: "+" as const,
            },
          ]
        : data.deliveryFree
          ? [
              {
                label: "التوصيل",
                value: D(data.deliveryWaivedAmount ?? 0).gt(0)
                  ? `مجاناً (قيمته ${money(data.deliveryWaivedAmount)})`
                  : "مجاناً",
                color: B.orange,
              },
            ]
          : []),
      ...(courier && fee.gt(0) && D(data.deliveryFee ?? 0).isZero()
        ? [
            {
              label: `أجرة التوصيل${facts.dead ? "" : ` (${courier.feeCollection === "COUNTER" ? "مقبوضة في الاستقبال" : courier.feeCollection === "SHOP" ? "على المكتبة" : `يقبضها ${courier.partyName} من الزبون`})`}`,
              value: money(courier.fee),
              sign: "+" as const,
              color: B.orange,
            },
            ...(facts.dead
              ? []
              : courier.feeCollection === "COURIER"
                ? remaining.isZero()
                  ? [
                      {
                        label:
                          "المطلوب من الزبون (أجرة التوصيل فقط — البضاعة مدفوعة مسبقاً)",
                        value: money(courier.fee),
                      },
                    ]
                  : [
                      {
                        label: "المجموع النهائي (يدفعه الزبون شاملاً التوصيل)",
                        value: money(remaining.plus(fee).toFixed(2)),
                      },
                    ]
                : remaining.gt(0)
                  ? [
                      {
                        label: "المطلوب من الزبون (متبقي الفاتورة)",
                        value: money(facts.remainingAmount),
                      },
                    ]
                  : [
                      {
                        label: "المطلوب من الزبون",
                        value: "0 د.ع (مدفوع بالكامل)",
                      },
                    ]),
          ]
        : []),
    ],
    grandTotal: {
      label: returnedLines.length
        ? "إجمالي الفاتورة الأصلي"
        : "الإجمالي المستحق",
      value: money(data.total),
    },
    paid:
      data.paidAmount != null
        ? { label: "المدفوع", value: money(data.paidAmount) }
        : null,
    remaining: remaining.gt(0)
      ? { label: "المتبقّي", value: money(facts.remainingAmount) }
      : null,
    balance: after
      ? {
          beforeLabel: "الرصيد السابق",
          before: money(facts.balanceBefore ?? 0),
          afterLabel: "الرصيد النهائي (الحساب الكلي)",
          after: money(after.abs().toFixed(2)),
          direction: after.abs().lt("0.01")
            ? "خالص"
            : after.gt(0)
              ? "لنا"
              : "علينا",
          directionColor: B.alert,
        }
      : null,
  });
}
