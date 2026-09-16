import type { ReactNode } from "react";
import { Link } from "wouter";
import type { ColumnDef } from "@tanstack/react-table";
import { Gift, Paperclip } from "lucide-react";
import { CopyInline } from "@/components/CopyButton";
import { fmtDate, fmtDateTime, toDate, type DateInput } from "@/lib/date";
import { D, fmt } from "@/lib/money";
import { paymentMethodLabel } from "@/lib/paymentMethod";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc";

export type InvoiceDetailData = NonNullable<RouterOutputs["sales"]["get"]>;
export type InvoiceReturnRow = NonNullable<InvoiceDetailData["returns"]>[number];
export type InvoiceItemRow = InvoiceDetailData["items"][number];
export type InvoicePaymentRow = NonNullable<InvoiceDetailData["payments"]>[number];

export const PAY_STATUS: Record<string, string> = {
  COMPLETED: "مكتملة",
  PENDING: "معلّقة",
  FAILED: "فاشلة",
  CANCELLED: "ملغاة",
};

export const cmpMoney = (a: string | number | null | undefined, b: string | number | null | undefined) =>
  D(a ?? 0).cmp(D(b ?? 0));

export const cmpTime = (a: DateInput, b: DateInput) => {
  const ta = toDate(a)?.getTime() ?? -Infinity;
  const tb = toDate(b)?.getTime() ?? -Infinity;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
};

export const invoiceReturnColumns: ColumnDef<InvoiceReturnRow, unknown>[] = [
  {
    id: "createdAt",
    header: "التاريخ",
    accessorFn: (r) => fmtDateTime(r.createdAt),
    meta: { kind: "datetime" },
    sortingFn: (a, b) => cmpTime(a.original.createdAt, b.original.createdAt),
    cell: ({ row }) => fmtDateTime(row.original.createdAt),
  },
  {
    id: "performedBy",
    header: "منفّذ المرتجع",
    accessorFn: (r) => r.performedByName ?? "غير موثّق",
    meta: { kind: "actor" },
    cell: ({ row }) => row.original.performedByName ?? "غير موثّق",
  },
  {
    id: "amount",
    header: "القيمة",
    accessorFn: (r) => fmt(D(r.amount).abs().toString()),
    meta: { kind: "money" },
    sortingFn: (a, b) => D(a.original.amount).abs().cmp(D(b.original.amount).abs()),
    cell: ({ row }) => fmt(D(row.original.amount).abs().toString()),
  },
];

export function invoiceItemColumns(subtotal: string): ColumnDef<InvoiceItemRow, unknown>[] {
  return [
    {
      id: "product",
      header: "المنتج",
      accessorFn: (it) => `${it.productName ?? "—"}${it.variantName ? ` — ${it.variantName}` : ""}`,
      meta: { width: "wide", wrap: true },
      footer: "مجموع البنود",
      cell: ({ row }) => {
        const it = row.original;
        return (
          <span>
            {it.productName ?? "—"}
            {it.variantName ? ` — ${it.variantName}` : ""}{" "}
            {it.isGift && (
              <span className="badge-status-active inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-extrabold">
                <Gift aria-hidden className="size-3" /> هدية
              </span>
            )}{" "}
            {it.sku && <span className="text-xs text-muted-foreground font-mono" dir="ltr">{it.sku}</span>}
          </span>
        );
      },
    },
    {
      id: "unit",
      header: "الوحدة",
      accessorFn: (it) => it.unitName ?? "—",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.unitName ?? "—"}</span>,
    },
    {
      id: "quantity",
      header: "الكمية",
      accessorFn: (it) => it.quantity,
      meta: { kind: "number", align: "center" },
      cell: ({ row }) => row.original.quantity,
    },
    {
      id: "unitPrice",
      header: "سعر الوحدة",
      accessorFn: (it) => fmt(it.unitPrice),
      meta: { kind: "money" },
      sortingFn: (a, b) => cmpMoney(a.original.unitPrice, b.original.unitPrice),
      cell: ({ row }) => <CopyInline value={row.original.unitPrice} display={fmt(row.original.unitPrice)} />,
    },
    {
      id: "total",
      header: "إجمالي السطر",
      accessorFn: (it) => fmt(it.total),
      meta: { kind: "money" },
      sortingFn: (a, b) => cmpMoney(a.original.total, b.original.total),
      footer: fmt(subtotal),
      cell: ({ row }) => <CopyInline value={row.original.total} display={fmt(row.original.total)} />,
    },
    {
      id: "returned",
      header: "مرتجع",
      accessorFn: (it) => `${it.returnedBaseQuantity}/${it.baseQuantity}`,
      meta: { kind: "number", align: "center" },
      cell: ({ row }) => {
        const it = row.original;
        const returned = Number(it.returnedBaseQuantity) > 0;
        return (
          <span className={`text-xs ${returned ? "text-[var(--sem-warn)] font-medium" : "text-muted-foreground"}`}>
            {it.returnedBaseQuantity}/{it.baseQuantity}
          </span>
        );
      },
    },
  ];
}

export function invoicePaymentColumns(canOpenVouchers: boolean): ColumnDef<InvoicePaymentRow, unknown>[] {
  return [
    {
      id: "createdAt",
      header: "التاريخ",
      accessorFn: (p) => fmtDateTime(p.createdAt),
      meta: { kind: "datetime" },
      sortingFn: (a, b) => cmpTime(a.original.createdAt, b.original.createdAt),
      cell: ({ row }) => fmtDateTime(row.original.createdAt),
    },
    {
      id: "direction",
      header: "الاتجاه",
      accessorFn: (p) => (p.direction === "IN" ? "وارد" : "صادر"),
      meta: { kind: "status" },
      cell: ({ row }) => (
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
            row.original.direction === "IN"
              ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
              : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
          )}
        >
          {row.original.direction === "IN" ? "وارد" : "صادر"}
        </span>
      ),
    },
    {
      id: "paymentMethod",
      header: "الطريقة",
      accessorFn: (p) => paymentMethodLabel(p.paymentMethod),
      cell: ({ row }) => paymentMethodLabel(row.original.paymentMethod),
    },
    {
      id: "amount",
      header: "المبلغ",
      accessorFn: (p) => fmt(p.amount),
      meta: { kind: "money" },
      sortingFn: (a, b) => cmpMoney(a.original.amount, b.original.amount),
      cell: ({ row }) => <CopyInline value={row.original.amount} display={fmt(row.original.amount)} />,
    },
    {
      id: "status",
      header: "الحالة",
      accessorFn: (p) => PAY_STATUS[p.status] ?? p.status,
      meta: { kind: "status" },
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{PAY_STATUS[row.original.status] ?? row.original.status}</span>,
    },
    {
      id: "voucher",
      header: "سند/مرفق",
      accessorFn: (p) => p.voucherNumber ?? (p.attachmentUrl ? "مرفق" : "—"),
      enableSorting: false,
      cell: ({ row }) => {
        const p = row.original;
        return (
          <span className="text-xs">
            {p.voucherNumber &&
              (canOpenVouchers ? (
                <Link
                  href={`/vouchers?q=${encodeURIComponent(p.voucherNumber)}`}
                  className="text-primary hover:underline"
                  title="فتح السند"
                >
                  {p.voucherNumber}
                </Link>
              ) : (
                <span className="text-muted-foreground">{p.voucherNumber}</span>
              ))}
            {p.attachmentUrl && (
              <a href={p.attachmentUrl} target="_blank" rel="noreferrer" title="فتح المُرفق" className="ms-1 inline-block">
                <Paperclip aria-hidden className="size-3.5 text-[var(--sem-pos)] inline" />
              </a>
            )}
            {!p.voucherNumber && !p.attachmentUrl && "—"}
          </span>
        );
      },
    },
  ];
}

/** حقل وصفي: عنوان صغير + قيمة. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5 min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium truncate">{children}</div>
    </div>
  );
}

/** سطر في لوحة الملخّص المالي: تسمية يميناً + مبلغ يساراً (LTR، بلا اقتطاع، قابل للنسخ). */
export function SummaryRow({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "amber" | "emerald";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className={cn(
          "text-muted-foreground",
          strong && "font-semibold text-foreground",
        )}
      >
        {label}
      </span>
      <span
        dir="ltr"
        className={cn(
          "tabular-nums",
          strong ? "text-lg font-bold" : "text-sm",
          tone === "amber" && "text-[var(--sem-warn)]",
          tone === "emerald" && "text-[var(--sem-pos)]",
        )}
      >
        <CopyInline value={value} display={fmt(value)} mono={false} />
      </span>
    </div>
  );
}
