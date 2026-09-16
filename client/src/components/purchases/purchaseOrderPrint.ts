import { D, fmtAr, round2, toUnitPriceStr } from "@/lib/money";
import { fmtDate, type DateInput } from "@/lib/date";
import { printReportDoc } from "@/lib/printing/reportDoc";
import { calcLineTotal, type InvoiceLine } from "@/components/invoice";
import { priceDecimalsFor, type PriceCurrency } from "@shared/moneyPrecision";
import { notify } from "@/lib/notify";
import { safeMoney, type PurchaseLandedCostResult } from "./PurchaseShippingCard";

export interface PrintPurchaseOrderOptions {
  title?: string;
  docNum: string | null;
  statusLabel: string;
  docDate: DateInput;
  branchName?: string;
  currency: PriceCurrency | string;
  agreedRate: string;
  paymentTerms?: string;
  shippingCost: string;
  customsCost: string;
  notes: string;
  terms?: string;
  supplierName: string;
  items: InvoiceLine[];
  docTotals: {
    grossSubtotal: string;
    subtotal: string;
    discount?: string;
    tax?: string;
    total: string;
  };
  landed: PurchaseLandedCostResult;
  showBranch?: boolean;
  taxRatePercent?: string | null;
}

export function printPurchaseOrderDoc({
  title = "أمر شراء",
  docNum,
  statusLabel,
  docDate,
  branchName,
  currency,
  agreedRate,
  paymentTerms,
  shippingCost,
  customsCost,
  notes,
  terms,
  supplierName,
  items,
  docTotals,
  landed,
  showBranch = false,
  taxRatePercent,
}: PrintPurchaseOrderOptions): void {
  if (items.length === 0) {
    notify.warn("لا توجد بنود لطباعتها.");
    return;
  }
  const usd = currency === "USD";
  const priceSym = usd ? "$" : "د.ع";
  const rate = safeMoney(agreedRate);

  if (usd && !rate.gt(0)) {
    notify.warn("أدخل سعر الصرف المثبت للفاتورة قبل الطباعة.");
    return;
  }
  const showIqdEquivalent = usd && rate.gt(0);

  const priceDp = priceDecimalsFor(currency);
  const fmtPrice = (v: string) =>
    Number(
      toUnitPriceStr(safeMoney(v).toString(), currency as PriceCurrency),
    ).toLocaleString("ar-IQ-u-nu-latn", { maximumFractionDigits: priceDp });

  const rows = items.map((l) => {
    const lineTotal = calcLineTotal(l);
    return {
      barcode: l.barcode ?? "—",
      name: l.name,
      unit: l.unit || "—",
      price: fmtPrice(l.price),
      qty: fmtAr(safeMoney(String(l.qty)).toString()),
      total: fmtAr(lineTotal),
      iqd: showIqdEquivalent
        ? fmtAr(round2(D(lineTotal).times(rate)).toFixed(2))
        : "",
    };
  });

  const discountAmount = safeMoney(docTotals.discount);
  const taxAmount = safeMoney(docTotals.tax);

  const summary = [
    { label: `المجموع الفرعي (${priceSym})`, value: fmtAr(docTotals.grossSubtotal || docTotals.subtotal) },
    ...(discountAmount.gt(0)
      ? [
          {
            label: `خصم فاتورة المورّد (${priceSym})`,
            value: `− ${fmtAr(discountAmount.toFixed(2))}`,
          },
        ]
      : []),
    ...(taxAmount.gt(0)
      ? [
          {
            label: `الضريبة (${fmtAr(taxRatePercent || "0")}%) (${priceSym})`,
            value: fmtAr(taxAmount.toFixed(2)),
          },
        ]
      : []),
    ...(usd
      ? [
          {
            label: "الإجمالي النهائي ($)",
            value: `${fmtAr(docTotals.total)} $`,
          },
          ...(rate.gt(0)
            ? [
                {
                  label: "سعر التثبيت",
                  value: `${fmtAr(agreedRate)} د.ع/$`,
                },
              ]
            : []),
        ]
      : []),
    {
      label: usd ? "التكلفة بالدينار" : "الإجمالي النهائي",
      value: fmtAr(landed.grand.toFixed(2)),
      bold: true,
      large: true,
    },
  ];

  const orderFields = [
    { label: "رقم الأمر", value: docNum || "—" },
    { label: "الحالة", value: statusLabel },
    ...(showBranch && branchName ? [{ label: "الفرع", value: branchName }] : []),
    { label: "العملة", value: usd ? "دولار أمريكي" : "دينار عراقي" },
    ...(usd && rate.gt(0)
      ? [{ label: "سعر التثبيت", value: `${fmtAr(agreedRate)} د.ع/$` }]
      : []),
    ...(paymentTerms
      ? [
          {
            label: "التسوية",
            value:
              paymentTerms === "CASH"
                ? "نقدي عند كل استلام"
                : "آجل على المورّد",
          },
        ]
      : []),
    ...(safeMoney(shippingCost).gt(0)
      ? [
          {
            label: "الشحن (خارج الإجمالي)",
            value: `${fmtAr(shippingCost)} د.ع`,
          },
        ]
      : []),
    ...(safeMoney(customsCost).gt(0)
      ? [
          {
            label: "الكمرك (خارج الإجمالي)",
            value: `${fmtAr(customsCost)} د.ع`,
          },
        ]
      : []),
    ...(notes.trim()
      ? [{ label: "ملاحظات", value: notes.trim() }]
      : []),
    ...((terms ?? "").trim()
      ? [{ label: "الشروط والأحكام", value: (terms ?? "").trim() }]
      : []),
  ];

  const ok = printReportDoc({
    title,
    docNum: docNum || null,
    docDate: fmtDate(docDate),
    note:
      landed.hasLanded && landed.hasBase
        ? "الشحن والكمرك لا يُضافان إلى ذمّة المورّد ولا إلى تكلفة الصنف — يُسجَّلان مصروف نقلٍ على الشركة لحظة الاستلام."
        : undefined,
    meta: [
      {
        title: "معلومات المورد",
        fields: [{ label: "الاسم", value: supplierName || "—" }],
      },
      { title: "تفاصيل الأمر", fields: orderFields },
    ],
    columns: [
      { key: "barcode", label: "الباركود", width: "24mm", align: "center" },
      { key: "name", label: "المنتج" },
      { key: "unit", label: "الوحدة", width: "18mm", align: "center" },
      { key: "price", label: `السعر (${priceSym})`, width: "22mm", align: "left" },
      { key: "qty", label: "الكمية", width: "16mm", align: "center" },
      { key: "total", label: `الإجمالي (${priceSym})`, width: "24mm", align: "left" },
      ...(showIqdEquivalent
        ? [{ key: "iqd", label: "المعادل د.ع", width: "24mm", align: "left" as const }]
        : []),
    ],
    rows,
    summary,
    showIndex: true,
  });

  if (!ok) {
    notify.err("تعذّر فتح نافذة الطباعة — تحقّق من مانع النوافذ المنبثقة");
  }
}
