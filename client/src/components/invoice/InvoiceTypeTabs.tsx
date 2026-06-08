/**
 * InvoiceTypeTabs — segmented control to switch between invoice types.
 * Ported from `_design-bundle/project/invoice-header.jsx#InvoiceTypeTabs`.
 */
import { cn } from "@/lib/utils";
import { INVOICE_TYPES, type InvoiceType } from "./types";

export interface InvoiceTypeTabsProps {
  activeType: InvoiceType;
  onTypeChange: (type: InvoiceType) => void;
  /** Hide some tabs (e.g. cashier shouldn't see PURCHASE). */
  visibleTypes?: InvoiceType[];
}

export function InvoiceTypeTabs({ activeType, onTypeChange, visibleTypes }: InvoiceTypeTabsProps) {
  const types = (visibleTypes ?? (Object.keys(INVOICE_TYPES) as InvoiceType[])).map((k) => INVOICE_TYPES[k]);

  return (
    <div
      role="tablist"
      aria-label="نوع المستند"
      className="flex flex-wrap gap-1 rounded-xl bg-muted p-1.5"
    >
      {types.map((t) => {
        const active = t.key === activeType;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTypeChange(t.key)}
            className={cn(
              "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-4 py-2 text-sm transition",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? cn(t.colorBg, "font-extrabold text-white shadow-sm")
                : "font-semibold text-muted-foreground hover:bg-background/60"
            )}
          >
            <span className="text-base leading-none">{t.icon}</span>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
