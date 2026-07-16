/**
 * EntityPicker — customer (for SALE/QUOTATION/SALE_RETURN) or supplier (for PURCHASE/*_RETURN).
 *
 * الرصيد: "لنا عليه" (أخضر) أو "له علينا" (أحمر) حسب اتجاه الدين.
 *
 * **بحث خادميّ (١٦/٧)** — كان يُحمّل `customers.list`/`suppliers.list` عند الإقلاع، وكلاهما
 * **مقصوص عند ٥٠٠ صفّاً بلا بحث ولا offset**، ثمّ يُصفّي محلّياً. النتيجة: العميل رقم ٥٠١
 * **غير موجود** في المنتقي — لا يُرى ولا يُبحَث ولا يُختار، بلا أيّ مؤشّر (نفس نمط «ترقيم عميل
 * فوق بياناتٍ مقتطعة»). الآن: `search` خادميّ (q + limit) لا يُطلَق إلا عند فتح القائمة،
 * و`get` لاسم/رصيد المختار (فقد يكون خارج نتائج البحث الحالية).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fmtNum } from "./totals";
import { BalanceBadge, getBalanceDirection } from "@/components/BalanceBadge";
import { TIER_OPTIONS, type EntityRow, type InvoiceType } from "./types";

/** سقف نتائج البحث المعروضة — القائمة منسدلة قصيرة، والبحث يضيّق لا يستعرض. */
const SEARCH_LIMIT = 20;

export interface EntityPickerProps {
  type: InvoiceType;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** نصّ الزرّ حين لا اختيار. الافتراضي «— اختر العميل/المورد —»؛ في سياق **الفلترة** مرّر
   *  «— كل العملاء —» ليدلّ على أن غياب الاختيار = بلا تضييق (لا «لم تختر بعد»). */
  placeholder?: string;
  /** نصّ زرّ إلغاء الاختيار. الافتراضي «إلغاء اختيار …». */
  clearLabel?: string;
}

function isSaleSide(t: InvoiceType): boolean {
  return t === "SALE" || t === "QUOTATION" || t === "SALE_RETURN";
}

export function EntityPicker({ type, selectedId, onSelect, placeholder, clearLabel }: EntityPickerProps) {
  const isSale = isSaleSide(type);
  const entityLabel = isSale ? "العميل" : "المورد";

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

  // البحث خادميّ (يطال كل السجلّات لا أوّل ٥٠٠) ولا يُطلَق إلا والقائمة مفتوحة ⇒ لا تحميل
  // عند الإقلاع. debounce ليكتب المستخدم بلا طلبٍ لكل حرف. الاسم يُطابَق مطبَّعاً عربياً
  // خادمياً (searchNorm) ⇒ «احمد» يجد «أحمد» — وهو ما لم تكن الفلترة المحلّية تفعله.
  const dq = useDebouncedValue(q.trim(), 250);
  const searchInput = { q: dq || undefined, limit: SEARCH_LIMIT };
  const customersQ = trpc.customers.search.useQuery(searchInput, { enabled: isSale && open, staleTime: 30_000 });
  const suppliersQ = trpc.suppliers.search.useQuery(searchInput, { enabled: !isSale && open, staleTime: 30_000 });

  const isLoading = isSale ? customersQ.isFetching : suppliersQ.isFetching;
  const rows: EntityRow[] = useMemo(
    () => ((isSale ? customersQ.data?.rows : suppliersQ.data?.rows) ?? []) as EntityRow[],
    [isSale, customersQ.data, suppliersQ.data],
  );

  // المختار يُجلَب بـid مستقلاً عن نتائج البحث: قد يكون خارجها (أو خارج أيّ سقف) ⇒ لولا هذا
  // لأفرغ اسمُه وشارةُ رصيده بمجرّد الكتابة في البحث. استعلامٌ واحد رخيص + cache ٦٠ث.
  const customerGet = trpc.customers.get.useQuery(
    { customerId: selectedId ?? 0 },
    { enabled: isSale && selectedId != null, staleTime: 60_000 },
  );
  const supplierGet = trpc.suppliers.get.useQuery(
    { supplierId: selectedId ?? 0 },
    { enabled: !isSale && selectedId != null, staleTime: 60_000 },
  );
  const selected = useMemo(
    () => (selectedId == null ? null : (((isSale ? customerGet.data : supplierGet.data) ?? null) as EntityRow | null)),
    [selectedId, isSale, customerGet.data, supplierGet.data],
  );

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
        <span className="truncate">{selected ? selected.name : (placeholder ?? `— اختر ${entityLabel} —`)}</span>
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
            {isLoading && rows.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">جارٍ البحث…</div>
            )}
            {rows.length === 0 && !isLoading && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">لا نتائج</div>
            )}
            {rows.map((e) => {
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
                {clearLabel ?? `إلغاء اختيار ${entityLabel}`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
