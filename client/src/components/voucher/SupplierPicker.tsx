// SupplierPicker — مَوازي CustomerPicker لكن لـsuppliers (للسندات). بَحث خادمي مَع debounce
// قائم على TanStack Query (مفتاح يَتغيّر مع q ⇒ debouncing طبيعي بـuseQuery).
// لا تَحميل ٥٠٠ مورّد عند الإقلاع: فارغ ⇒ «اختر مورّداً». اكتب حَرفين ⇒ اقتراحات.
import { BalanceBadge, balanceOptionText } from "@/components/BalanceBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export interface SupplierPickerProps {
  supplierId: number | null;
  onSupplierChange: (id: number | null) => void;
  label?: string;
}

export default function SupplierPicker({ supplierId, onSupplierChange, label = "المورّد *" }: SupplierPickerProps) {
  const fetched = trpc.suppliers.get.useQuery(
    { supplierId: supplierId ?? 0 },
    { enabled: supplierId != null, staleTime: 60_000 },
  );

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const trimmed = q.trim();
  const enabled = trimmed.length >= 2 && supplierId == null;
  const summary = trpc.suppliers.search.useQuery(
    { q: trimmed, limit: 8 },
    { enabled, staleTime: 30_000 },
  );
  const suggestions = summary.data?.rows ?? [];

  function pickSuggestion(id: number) {
    onSupplierChange(id);
    setQ("");
    setOpen(false);
  }
  function clearPick() {
    onSupplierChange(null);
    setQ("");
  }

  const selectedName = fetched.data?.name ?? null;
  const selectedBalance = fetched.data?.currentBalance as string | undefined;

  return (
    <div className="space-y-1" ref={wrapRef}>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {supplierId != null && selectedBalance != null && (
          <BalanceBadge amount={selectedBalance} entityType="supplier" showZero />
        )}
      </div>

      {supplierId != null ? (
        <div className="flex gap-2">
          <div className="flex-1 flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 h-9 text-sm">
            <span className="truncate">{selectedName ?? `#${supplierId}`}</span>
            <button
              type="button"
              onClick={clearPick}
              className="text-xs text-muted-foreground hover:text-destructive shrink-0"
              aria-label="مسح اختيار المورّد"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="relative">
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder="ابحث عن مورّد (اسم/هاتف)"
            aria-autocomplete="list"
            aria-expanded={open}
          />
          {open && enabled && (
            <div className="absolute z-20 top-full mt-1 right-0 w-full rounded-md border bg-popover shadow-md max-h-72 overflow-auto">
              {summary.isLoading && <div className="px-3 py-2 text-sm text-muted-foreground">جارٍ البحث…</div>}
              {!summary.isLoading && suggestions.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">لا نتائج.</div>
              )}
              {!summary.isLoading && suggestions.length > 0 && (
                <ul className="py-1">
                  {suggestions.map((s: any) => (
                    <li key={Number(s.id)}>
                      <button
                        type="button"
                        onClick={() => pickSuggestion(Number(s.id))}
                        className="w-full text-right px-3 py-2 hover:bg-accent flex items-center justify-between gap-2"
                      >
                        <span className="truncate">
                          {s.name}
                          {balanceOptionText(s.currentBalance, "supplier")}
                        </span>
                        {s.phone && <span className="text-[11px] text-muted-foreground shrink-0" dir="ltr">{s.phone}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
