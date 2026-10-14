/**
 * CustomerSearchPicker — منتقي البحث السريع عن الزبائن للوصول المباشر للملف الشامل 360°
 *
 * يوفر شريط بحث سريع يدعم الاسم المطبع عربياً، ورقم الهاتف (07xx)، وقارئ الباركود الفيزيائي،
 * ويعرض قائمة بالنتائج المطابقة مع شارات الحالة والرصيد، ويفتح درج الملف الشامل 360° بنقرة واحدة.
 *
 * خاضع لحراس المستودع: صفر إيموجي (lucide-react حصراً)، توكنز دلالية، وتنسيق الأرقام عبر fmtAr.
 */

import { useState, useRef, useEffect } from "react";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { trpc } from "@/lib/trpc";
import { fmtAr, D } from "@/lib/money";
import { User, Loader2, Phone, Search, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface CustomerSearchPickerProps {
  onSelectCustomer: (customerId: number) => void;
  className?: string;
  placeholder?: string;
}

export function CustomerSearchPicker({
  onSelectCustomer,
  className,
  placeholder = "ابحث عن زبون بالاسم، الهاتف (07xx)، أو امسح الباركود لفتح الملف 360°...",
}: CustomerSearchPickerProps) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  const searchResults = trpc.customers.smartSearch.useQuery(
    { q: trimmed, limit: 6 },
    { enabled: trimmed.length >= 2, staleTime: 30_000 }
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const results = searchResults.data ?? [];

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      <UnifiedSearchInput
        value={query}
        onChange={(val) => {
          setQuery(val);
          setIsOpen(val.trim().length >= 2);
        }}
        placeholder={placeholder}
        barcode={true}
        size="default"
        aria-label="البحث عن زبون لفتح الملف الشامل"
      />
      {isOpen && trimmed.length >= 2 && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-border/80 bg-popover/95 p-1.5 shadow-xl backdrop-blur-md">
          {searchResults.isLoading ? (
            <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
              <span>جارٍ البحث في سجلات الزبائن...</span>
            </div>
          ) : results.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              لا يوجد زبون مطابق لنص البحث
            </div>
          ) : (
            <div className="space-y-1">
              {results.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onSelectCustomer(c.id);
                    setQuery("");
                    setIsOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-lg p-2.5 text-start transition hover:bg-accent/70 focus-visible:bg-accent focus-visible:outline-none"
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <User className="size-4" aria-hidden />
                    </div>
                    <div className="truncate">
                      <div className="font-semibold text-sm truncate">{c.name}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {c.phone && <span dir="ltr">{c.phone}</span>}
                        {c.customerType && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                            {c.customerType}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.currentBalance != null && (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-semibold",
                          D(c.currentBalance).gt(0)
                            ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
                            : "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                        )}
                      >
                        {fmtAr(c.currentBalance)} د.ع
                      </span>
                    )}
                    <Badge variant="secondary" className="gap-1 text-[10px] hidden sm:inline-flex">
                      <User className="size-3" aria-hidden />
                      <span>الملف الشامل 360°</span>
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
