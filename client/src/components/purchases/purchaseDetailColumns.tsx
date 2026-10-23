import { variantDescriptor, variantDisplayName } from "@shared/variantDisplay";
import { fmtAr, formatQuantity } from "@/lib/money";
import type { RouterOutputs } from "@/lib/trpc";
import type { ColumnDef } from "@tanstack/react-table";
export type PoItemRow = NonNullable<
  RouterOutputs["purchases"]["get"]
>["items"][number];

export function poItemColumns(isUsd: boolean): ColumnDef<PoItemRow, unknown>[] {
  return [
    {
      id: "product",
      header: "الصنف",
      accessorFn: (it) =>
        variantDisplayName({
          productName: it.productName ?? "—",
          variantName: it.variantName,
          color: it.color,
          size: it.size,
          variantKind: it.variantKind,
          sku: it.sku,
        }),
      meta: { width: "wide" },
      cell: ({ row }) => {
        const it = row.original;
        const desc = variantDescriptor({
          productName: it.productName ?? "—",
          variantName: it.variantName,
          color: it.color,
          size: it.size,
          variantKind: it.variantKind,
          sku: it.sku,
        });
        return (
          <div className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-foreground">
                {it.productName ?? "—"}
              </span>
              {desc ? (
                <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {it.colorHex && /^#[0-9a-fA-F]{6}$/.test(it.colorHex) ? (
                    <span
                      aria-hidden="true"
                      className="inline-block size-2.5 shrink-0 rounded-full border border-border/60"
                      style={{ backgroundColor: it.colorHex }}
                    />
                  ) : null}
                  <span>{desc}</span>
                </span>
              ) : null}
            </div>
            {it.sku ? (
              <span
                className="text-[11px] text-muted-foreground font-mono"
                dir="ltr"
              >
                {it.sku}
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "unit",
      header: "الوحدة",
      accessorFn: (it) => it.unitName ?? "—",
      cell: ({ row }) => row.original.unitName ?? "—",
    },
    {
      id: "quantity",
      header: "الكمية",
      accessorFn: (it) => formatQuantity(it.quantity),
      meta: { kind: "number" },
      cell: ({ row }) => formatQuantity(row.original.quantity),
    },
    {
      id: "received",
      header: "المستلَم / المطلوب",
      accessorFn: (it) =>
        formatQuantity(it.receivedBaseQuantity) +
        " / " +
        formatQuantity(it.baseQuantity),
      meta: { kind: "number" },
      cell: ({ row }) => (
        <span className="tabular-nums font-mono text-xs">
          {formatQuantity(row.original.receivedBaseQuantity)} /{" "}
          {formatQuantity(row.original.baseQuantity)}
        </span>
      ),
    },
    {
      id: "unitPrice",
      header: isUsd ? "السعر ($)" : "السعر",
      accessorFn: (it) =>
        isUsd
          ? formatQuantity(it.usdUnitPrice, { maximumFractionDigits: 4 })
          : fmtAr(it.unitPrice),
      meta: { kind: "money" },
      cell: ({ row }) =>
        isUsd
          ? formatQuantity(row.original.usdUnitPrice, {
              maximumFractionDigits: 4,
            })
          : fmtAr(row.original.unitPrice),
    },
    {
      id: "total",
      header: isUsd ? "الإجمالي ($)" : "الإجمالي",
      accessorFn: (it) => fmtAr(isUsd ? it.usdTotal : it.total),
      meta: { kind: "money" },
      cell: ({ row }) =>
        fmtAr(isUsd ? row.original.usdTotal : row.original.total),
    },
  ];
}
