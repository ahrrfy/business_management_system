import type { ExportColumn } from "./export";
import { D } from "./money";

export const AR_AGING_LEGACY_BASIS = "عند غياب دفتر الفرع للمستندات القديمة، يُعرض تقدير محافظ محدود برصيد الشركة الموجب؛ لا يثبت تخصيصًا أو نقل رصيد بين الفروع. الرصيد الافتتاحي وغير المفوتر خارج دلاء الأعمار.";

export const AGING_OUTPUT_BUCKETS = [
  { key: "d0_30", label: "0–30 يوم" },
  { key: "d31_60", label: "31–60 يوم" },
  { key: "d61_90", label: "61–90 يوم" },
  { key: "d91p", label: "أكثر من 90" },
] as const;

type MoneyKey =
  | (typeof AGING_OUTPUT_BUCKETS)[number]["key"]
  | "unpaidTotal"
  | "currentBalance";
type AgingOutputRow = Record<MoneyKey, string | null> & {
  customerName?: string;
  supplierName?: string;
  customerType?: string | null;
  phone?: string | null;
  unbucketed?: string | null;
  oldestInvoiceDate?: string | null;
  oldestPoDate?: string | null;
};
type Meta = { label: string; value: string };
type Options = {
  kind: "AR" | "AP";
  branchName: string;
  query: string;
  bucket: string;
  customerType?: string;
  selected?: boolean;
};

/** One consistent scope for the filtered table, spreadsheet rows and printed totals. */
export function buildAgingOutput<T extends AgingOutputRow>(
  rows: T[],
  options: Options,
) {
  const isAR = options.kind === "AR";
  const meta: Meta[] = [{ label: "الفرع", value: options.branchName }];
  if (isAR) meta.push({ label: "أساس الرصيد القديم", value: AR_AGING_LEGACY_BASIS });
  if (options.selected) meta.push({ label: "النطاق", value: "الصفوف المحددة" });
  if (options.query.trim())
    meta.push({ label: "البحث", value: options.query.trim() });
  const bucket = AGING_OUTPUT_BUCKETS.find(
    (entry) => entry.key === options.bucket,
  );
  if (bucket) meta.push({ label: "الشريحة", value: bucket.label });
  if (options.customerType)
    meta.push({ label: "فئة العميل", value: options.customerType });

  const sum = (key: MoneyKey) =>
    rows.reduce((total, row) => total.plus(D(row[key] || 0)), D(0)).toNumber();
  const totals = {
    d0_30: sum("d0_30"),
    d31_60: sum("d31_60"),
    d61_90: sum("d61_90"),
    d91p: sum("d91p"),
    unpaidTotal: sum("unpaidTotal"),
    currentBalance: sum("currentBalance"),
  };
  const unbilled = (row: T) =>
    D(row.currentBalance || 0).minus(D(row.unpaidTotal || 0));
  const unbucketed = (row: T) =>
    isAR && row.unbucketed != null ? D(row.unbucketed) : unbilled(row);
  const unbucketedTotal = rows
    .reduce((sum, row) => sum.plus(unbucketed(row)), D(0))
    .toNumber();
  const columns: ExportColumn<T>[] = [
    {
      key: isAR ? "customerName" : "supplierName",
      header: isAR ? "العميل" : "المورد",
    },
    ...(isAR ? [{ key: "customerType", header: "الفئة" }] : []),
    { key: "phone", header: "الهاتف", text: true },
    ...AGING_OUTPUT_BUCKETS.map(({ key, label }) => ({
      key,
      header: label,
      map: (row: T) => Number(row[key] || 0),
    })),
    {
      key: "unpaidTotal",
      header: "إجمالي غير المدفوع",
      map: (row) => Number(row.unpaidTotal || 0),
    },
    {
      key: "unbilled",
      header: "غير مفوتر/افتتاحي",
      map: (row) => unbilled(row).toNumber(),
    },
    {
      key: "currentBalance",
      header: "الرصيد الحالي",
      map: (row) => Number(row.currentBalance || 0),
    },
    {
      key: isAR ? "oldestInvoiceDate" : "oldestPoDate",
      header: isAR ? "أقدم فاتورة" : "أقدم أمر شراء",
    },
  ];
  return {
    rows,
    sheet: {
      csvReport: true,
      title: isAR
        ? "أعمار الذمم المدينة — لنا على العملاء"
        : "أعمار الذمم الدائنة — لهم علينا",
      meta,
      columns,
      totalsRow: {
        [isAR ? "customerName" : "supplierName"]: "الإجمالي",
        ...totals,
        unbilled: rows
          .reduce((sum, row) => sum.plus(unbilled(row)), D(0))
          .toNumber(),
      },
    },
    print: {
      rows: rows.map((row) => ({
        name: (isAR ? row.customerName : row.supplierName) ?? "—",
        d0_30: Number(row.d0_30 || 0),
        d31_60: Number(row.d31_60 || 0),
        d61_90: Number(row.d61_90 || 0),
        d91p: Number(row.d91p || 0),
        unpaidTotal: Number(row.unpaidTotal || 0),
        currentBalance: Number(row.currentBalance || 0),
        unbucketed: unbucketed(row).toNumber(),
      })),
      totals: {
        d0_30: totals.d0_30,
        d31_60: totals.d31_60,
        d61_90: totals.d61_90,
        d91p: totals.d91p,
        unpaidTotal: totals.unpaidTotal,
        currentBalance: totals.currentBalance,
        unbucketed: unbucketedTotal,
      },
      filters: meta.map(({ label, value }) => `${label}: ${value}`).join(" · "),
    },
  };
}
