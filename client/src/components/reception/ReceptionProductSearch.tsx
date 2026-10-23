import { ClipboardList, CreditCard, Package, Palette } from "lucide-react";

import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { fmt } from "@/lib/money";

import { cn } from "@/lib/utils";

import { type PosRow } from "@/components/reception/cartMath";

export interface ReceptionProductSearchInput {
  searchWrapRef: React.RefObject<HTMLDivElement | null>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  search: string;
  setSearch: React.Dispatch<React.SetStateAction<string>>;
  setShowDrop: React.Dispatch<React.SetStateAction<boolean>>;
  handleSearchScan: (code: string) => void;
  searchSettled: boolean;
  results: import("@/components/reception/cartMath").PosRow[];
  addRow: (row: import("@/components/reception/cartMath").PosRow) => void;
  showDrop: boolean;
  debounced: string;
  resultsEmpty: boolean;
  addManualService: () => void;
  canActionRef: React.RefObject<(path: string) => boolean>;
  setCardsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  offline: boolean;
  canAction: (path: string) => boolean;
}
export function ReceptionProductSearch({
  searchWrapRef,
  searchRef,
  search,
  setSearch,
  setShowDrop,
  handleSearchScan,
  searchSettled,
  results,
  addRow,
  showDrop,
  debounced,
  resultsEmpty,
  addManualService,
  canActionRef,
  setCardsOpen,
  offline,
  canAction,
}: ReceptionProductSearchInput) {
  return (
    <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
      <span className="shrink-0 text-xs font-extrabold">
        ٢. أضف ما يريده العميل
      </span>
      <div
        ref={searchWrapRef}
        className="relative w-full flex-1 sm:max-w-[640px] sm:min-w-72"
      >
        <UnifiedSearchInput
          ref={searchRef}
          autoFocus
          id="reception-search"
          value={search}
          debounceMs={0}
          onChange={(v) => {
            setSearch(v);
            setShowDrop(true);
          }}
          onScan={handleSearchScan}
          onFocus={() => {
            if (search) setShowDrop(true);
          }}
          onKeyDown={(e) => {
            if (e.defaultPrevented) return;
            if (e.key === "Enter" && searchSettled && results[0]) {
              e.preventDefault();
              addRow(results[0]);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setSearch("");
              setShowDrop(false);
            }
          }}
          placeholder="امسح الباركود أو ابحث بالاسم / SKU…  (F2)"
          inputClassName="h-9 rounded-lg border-[1.5px] text-xs font-semibold focus:border-primary"
        />
        {showDrop && debounced.trim().length >= 2 && (
          <div className="absolute inset-x-0 top-[calc(100%+6px)] z-40 max-h-[340px] overflow-y-auto rounded-xl border bg-card p-1.5 shadow-xl">
            {resultsEmpty && (
              <div className="p-5 text-center text-xs text-muted-foreground">
                لا نتائج — جرّب اسماً آخر أو SKU
              </div>
            )}
            {results.map((r) => (
              <button
                key={r.productUnitId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  addRow(r);
                }}
                className="flex w-full items-center gap-3 rounded-lg p-2 text-right hover:bg-muted/60"
              >
                <div
                  className={cn(
                    "grid size-9 flex-shrink-0 place-items-center rounded-lg",
                    r.isCustomizable
                      ? "bg-violet-100 text-violet-700"
                      : "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
                  )}
                >
                  {r.isCustomizable ? (
                    <Palette aria-hidden className="size-4" />
                  ) : (
                    <Package aria-hidden className="size-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-semibold">
                      {r.productName}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
                        r.isCustomizable
                          ? "bg-violet-100 text-violet-700"
                          : "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
                      )}
                    >
                      {r.isCustomizable ? "تخصيص" : "جاهز"}
                    </span>
                  </div>
                  <div
                    className="mt-0.5 text-[11px] text-muted-foreground"
                    dir="ltr"
                  >
                    <span className="text-right">
                      {r.sku} · {r.unitName}
                    </span>
                    {!r.isService && (
                      <span className="ms-2">
                        · فعلي: {r.stockBase ?? 0} · محجوز:{" "}
                        {r.reservedBase ?? 0} · متاح:{" "}
                        {r.availableBase ?? r.stockBase ?? 0}
                      </span>
                    )}
                  </div>
                </div>
                <div
                  className="shrink-0 text-xs font-bold tabular-nums"
                  dir="ltr"
                >
                  {r.price ? fmt(r.price) : "—"}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={addManualService}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border-2 border-violet-500 bg-violet-50 px-3 text-xs font-extrabold text-violet-700 transition-colors hover:bg-violet-100"
      >
        <ClipboardList aria-hidden className="size-3.5" /> إضافة خدمة / أمر شغل
      </button>

      <button
        type="button"
        onClick={() =>
          canActionRef.current("digitalCards.pos.listCards") &&
          setCardsOpen(true)
        }
        disabled={offline || !canAction("digitalCards.pos.listCards")}
        title={
          offline
            ? "البيع الرقمي يحتاج اتصالاً بالخادم"
            : "الكروت والاشتراكات (F3)"
        }
        className={cn(
          "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border-2 px-3 text-xs font-extrabold transition-colors",
          offline
            ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
            : "border-primary/60 bg-primary/10 text-primary hover:bg-primary/20",
        )}
      >
        <CreditCard aria-hidden className="size-3.5" /> الكروت والاشتراكات
      </button>
    </div>
  );
}
