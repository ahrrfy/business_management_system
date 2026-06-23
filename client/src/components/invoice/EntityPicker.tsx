/**
 * EntityPicker — customer (for SALE/QUOTATION/SALE_RETURN) or supplier (for PURCHASE/*_RETURN).
 *
 * الرصيد: "لنا عليه" (أخضر) أو "له علينا" (أحمر) حسب اتجاه الدين.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fmtNum } from "./totals";
import { BalanceBadge, getBalanceDirection } from "@/components/BalanceBadge";
import { TIER_OPTIONS, type EntityRow, type InvoiceType } from "./types";

export interface EntityPickerProps {
  type: InvoiceType;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

function isSaleSide(t: InvoiceType): boolean {
  return t === "SALE" || t === "QUOTATION" || t === "SALE_RETURN";
}

export function EntityPicker({ type, selectedId, onSelect }: EntityPickerProps) {
  const isSale = isSaleSide(type);
  const entityLabel = isSale ? "العميل" : "المورد";

  const customers = trpc.customers.list.useQuery(undefined, { enabled: isSale });
  const suppliers = trpc.suppliers.list.useQuery(undefined, { enabled: !isSale });

  const rows: EntityRow[] = useMemo(() => {
    if (isSale) return (customers.data ?? []) as EntityRow[];
    return (suppliers.data ?? []) as EntityRow[];
  }, [isSale, customers.data, suppliers.data]);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) => r.name.toLowerCase().includes(needle) || (r.phone ?? "").includes(needle)
    );
  }, [rows, q]);

  const balance = selected?.currentBalance ? Number(selected.currentBalance) : 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-3 text-sm transition",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected
            ? "border-primary bg-primary/10 font-bold text-primary"
            : "border-input bg-background font-medium text-muted-foreground hover:border-input/80"
        )}
      >
        <span className="truncate">{selected ? selected.name : `— اختر ${entityLabel} —`}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0" />
      </button>

      {selected && (
        <div className="mt-1 flex items-center justify-between px-1">
          <BalanceBadge
            amount={balance}
            entityType={isSale ? "customer" : "supplier"}
            showZero
            className="text-xs"
          />
        </div>
      )}

      {open && (
        <div
          role="listbox"
          className="absolute inset-x-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-xl border bg-card shadow-xl"
        >
          <div className="p-2">
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`ابحث عن ${entityLabel}...`}
              className="h-9 bg-muted"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {(isSale ? customers.isLoading : suppliers.isLoading) && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">جارٍ التحميل…</div>
            )}
            {filtered.length === 0 && !(isSale ? customers.isLoading : suppliers.isLoading) && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">لا نتائج</div>
            )}
            {filtered.map((e) => {
              const bal = e.currentBalance ? Number(e.currentBalance) : 0;
              return (
                <div
                  key={e.id}
                  role="option"
                  aria-selected={e.id === selectedId}
                  onClick={() => {
                    onSelect(e.id);
                    setOpen(false);
                    setQ("");
                  }}
                  className={cn(
                    "flex cursor-pointer items-center justify-between border-b px-3 py-2 last:border-b-0 hover:bg-muted",
                    e.id === selectedId && "bg-primary/10"
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{e.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.phone || "بلا هاتف"}
                      {e.defaultPriceTier && (
                        <span className="mr-2">• {TIER_OPTIONS.find((t) => t.value === e.defaultPriceTier)?.label}</span>
                      )}
                    </div>
                  </div>
                  {bal !== 0 && (() => {
                    const dir = getBalanceDirection(bal, isSale ? "customer" : "supplier");
                    return (
                      <span
                        dir="ltr"
                        className={cn(
                          "shrink-0 text-xs font-bold",
                          dir?.colorCls === "emerald" ? "text-emerald-700" : "text-rose-700"
                        )}
                      >
                        {fmtNum(Math.abs(bal))}
                      </span>
                    );
                  })()}
                </div>
              );
            })}
          </div>
          {selected && (
            <div className="border-t p-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full border-rose-300/40 bg-rose-50 text-rose-700 hover:bg-rose-100"
                onClick={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                إلغاء اختيار {entityLabel}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
