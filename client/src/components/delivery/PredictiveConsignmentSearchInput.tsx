/**
 * PredictiveConsignmentSearchInput — حقل البحث التنبؤي الذكي للطرود والإرساليات
 * 
 * الميزات الهندسية:
 * 1. يبحث بجزء من كم حرف (اسم الزبون أو العنوان) أو من كم رقم (هاتف، فاتورة، إرسالية، طلب).
 * 2. محرك هجين (Hybrid Engine): تصفية فورية 0ms للطرود المحملة بالذاكرة + استعلام خادمي ذكي عبر tRPC.
 * 3. قائمة تنبؤية فورية (Live Dropdown) تظهر تلقائياً عند كتابة حرفين أو رقمين فأكثر.
 * 4. إبراز شارات نوع التطابق: هاتف · زبون · فاتورة · إرسالية · عنوان · طلب.
 * 5. ملاحة كاملة بلوحة المفاتيح: الأسهم Up/Down للتنقل، Enter للاختيار، Esc للإغلاق، F2 للتركيز.
 * 6. صون المسافات والكتابة العربية: لا استدعاء لـ trim() أثناء الكتابة الحية.
 * 7. معايير سهولة الوصول WAI-ARIA Combobox كاملة وصفر إيموجي.
 */
import * as React from "react";
import { statementQueueRemaining } from "./companyStatementQueue";
import { Loader2, Search, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { playReadyBeep } from "@/lib/notifyBeep";
import { cn } from "@/lib/utils";
import { UnifiedSearchInput } from "@/components/search/UnifiedSearchInput";
import { PredictiveItemRow, type PredictiveItem } from "./PredictiveItemRow";

export type { PredictiveItem };

export interface PredictiveConsignmentSearchInputProps {
  /** استدعاء عند اختيار طرد من القائمة التنبؤية */
  onSelect: (item: PredictiveItem) => void;
  /** استدعاء اختياري عند الضغط على Enter للمسح المباشر بالباركود */
  onBarcodeEnter?: (raw: string) => void;
  /** تقييد البحث بجهة محددة (اختياري) */
  partyId?: number | null;
  /** طرود محملة مسبقاً في الذاكرة لتصفيتها فورياً (اختياري) */
  localCandidates?: readonly any[];
  /** نص التلميح */
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** تمكين اختصار F2 للتركيز على الحقل (افتراضياً true) */
  enableF2Shortcut?: boolean;
  className?: string;
  inputClassName?: string;
  /** عند مسح الحقل */
  onClear?: () => void;
}

/** تسوية الحروف العربية للبحث الجزئي */
function normalizeArabic(text: string): string {
  return text
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .toLowerCase();
}

/** تحويل الأرقام المشرقية إلى أرقام لاتينية قياسية */
function toAsciiDigits(str: string): string {
  return str
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));
}

export function PredictiveConsignmentSearchInput({
  onSelect,
  onBarcodeEnter,
  partyId,
  localCandidates,
  placeholder = "بحث برقم الهاتف، اسم الزبون، رقم الفاتورة أو الإرسالية…",
  autoFocus = false,
  disabled = false,
  enableF2Shortcut = true,
  className,
  inputClassName,
  onClear,
}: PredictiveConsignmentSearchInputProps) {
  const [searchTerm, setSearchTerm] = React.useState("");
  const [isOpen, setIsOpen] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState<number>(-1);

  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Debounce ذكي لكبح الطلبات الخادمية أثناء سرعة الكتابة
  const debouncedQuery = useDebouncedValue(searchTerm, 180);
  const hasMinLength = debouncedQuery.trim().length >= 2;

  // استعلام الخادم tRPC
  const serverQuery = trpc.delivery.predictiveSearch.useQuery(
    {
      query: debouncedQuery.trim(),
      partyId: partyId ? Number(partyId) : undefined,
      limit: 12,
    },
    {
      enabled: hasMinLength && !disabled,
      staleTime: 5_000,
    },
  );

  // دمج التصفية المحلية مع نتائج الخادم
  const combinedResults: PredictiveItem[] = React.useMemo(() => {
    const rawTrimmed = searchTerm.trim();
    if (rawTrimmed.length < 2) return [];

    const ascii = toAsciiDigits(rawTrimmed);
    const digits = ascii.replace(/\D/g, "");
    const normQ = rawTrimmed.toLowerCase();
    const normAr = normalizeArabic(normQ);

    const map = new Map<number, PredictiveItem>();

    // ١. تصفية المرشحين المحليين فورياً (إذا وُجدوا)
    if (localCandidates && localCandidates.length > 0) {
      for (const row of localCandidates) {
        if (partyId != null && row.partyId != null && Number(row.partyId) !== Number(partyId)) continue;
        const phone = toAsciiDigits(String(row.customerPhone ?? row.recipientPhone ?? ""));
        const name = String(row.customerName ?? row.recipientName ?? "");
        const normName = normalizeArabic(name);
        const inv = String(row.invoiceNumber ?? row.invoiceId ?? "");
        const cn = String(row.consignmentNumber ?? "");
        const ext = String(row.externalTrackingRef ?? "");
        const ord = String(row.orderNumber ?? "");
        const addr = String(row.address ?? row.deliveryAddress ?? "");
        const normAddr = normalizeArabic(addr);

        const matchedOn: PredictiveItem["matchedOn"] = [];
        let matched = false;

        if (digits.length >= 2 && phone.includes(digits)) {
          matchedOn.push("PHONE");
          matched = true;
        }
        if (cn.toLowerCase().includes(normQ) || (digits.length >= 2 && cn.includes(digits))) {
          matchedOn.push("CONSIGNMENT_NUMBER");
          matched = true;
        }
        if (ext && (ext.toLowerCase().includes(normQ) || (digits.length >= 2 && ext.includes(digits)))) {
          if (!matchedOn.includes("CONSIGNMENT_NUMBER")) matchedOn.push("CONSIGNMENT_NUMBER");
          matched = true;
        }
        if (inv.toLowerCase().includes(normQ) || (digits.length >= 2 && inv.includes(digits))) {
          matchedOn.push("INVOICE_NUMBER");
          matched = true;
        }
        if (ord && (ord.toLowerCase().includes(normQ) || (digits.length >= 2 && ord.includes(digits)))) {
          matchedOn.push("ORDER_NUMBER");
          matched = true;
        }
        if (normName.includes(normAr) || name.toLowerCase().includes(normQ)) {
          matchedOn.push("CUSTOMER_NAME");
          matched = true;
        }
        if (normAddr.includes(normAr) || addr.toLowerCase().includes(normQ)) {
          matchedOn.push("ADDRESS");
          matched = true;
        }

        if (matched) {
          const remaining = statementQueueRemaining(row);

          const item: PredictiveItem = {
            id: Number(row.id),
            consignmentNumber: cn,
            externalTrackingRef: ext || null,
            invoiceId: row.invoiceId ? Number(row.invoiceId) : null,
            invoiceNumber: inv || null,
            workOrderId: row.workOrderId ? Number(row.workOrderId) : null,
            onlineOrderId: row.onlineOrderId ? Number(row.onlineOrderId) : null,
            orderNumber: ord || null,
            partyId: Number(row.partyId ?? partyId ?? 0),
            partyName: String(row.partyName ?? "الجهة الحالية"),
            partyType: (row.partyType as "INDIVIDUAL" | "COMPANY") ?? "COMPANY",
            customerName: name || "عميل نقدي",
            customerPhone: phone || null,
            deliveryAddress: addr || null,
            parcelStatus: String(row.parcelStatus ?? "ASSIGNED"),
            moneyStatus: String(row.moneyStatus ?? "UNSETTLED"),
            status: String(row.status ?? "DISPATCHED"),
            codAmount: String(row.codAmount ?? "0.00"),
            collectedAmount: String(row.collectedAmount ?? "0.00"),
            counterSettledAmount: String(row.counterSettledAmount ?? "0.00"),
            remainingAmount: remaining.toFixed(2),
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            fulfillmentRequestId: row.fulfillmentRequestId,
            aftercareExecutionId: row.aftercareExecutionId,
            invoicePaymentMode: row.invoicePaymentMode,
            invoiceRemainingAmount: row.invoiceRemainingAmount,
            deliveryFee: row.deliveryFee,
            feeCollection: row.feeCollection,
            cashInCourierCustody: row.cashInCourierCustody,
            shortfallAssigned: row.shortfallAssigned,
            matchedOn: matchedOn.length > 0 ? matchedOn : ["CONSIGNMENT_NUMBER"],
            score: 1,
          };
          map.set(item.id, item);
        }
      }
    }

    // ٢. دمج نتائج الخادم
    if (debouncedQuery.trim() === rawTrimmed && serverQuery.data && serverQuery.data.length > 0) {
      for (const item of serverQuery.data) {
        map.set(item.id, item);
      }
    }

    return Array.from(map.values()).sort((a, b) => (a.score ?? 2) - (b.score ?? 2) || b.id - a.id);
  }, [searchTerm, debouncedQuery, localCandidates, serverQuery.data, partyId]);

  // التحكم بظهور القائمة
  React.useEffect(() => {
    if (searchTerm.trim().length >= 2) {
      setIsOpen(true);
    } else {
      setIsOpen(false);
      setHighlightedIndex(-1);
    }
  }, [searchTerm]);

  // التمرير التلقائي للعنصر المظلل في القائمة
  React.useEffect(() => {
    if (highlightedIndex >= 0 && combinedResults[highlightedIndex]) {
      const el = document.getElementById(`predictive-opt-${combinedResults[highlightedIndex].id}`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, combinedResults]);

  // إغلاق القائمة عند النقر خارج المكون
  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // اختصار F2 للتركيز على الحقل
  React.useEffect(() => {
    if (!enableF2Shortcut) return;
    function handleF2(e: KeyboardEvent) {
      if (e.key === "F2" && !disabled && inputRef.current) {
        e.preventDefault();
        inputRef.current.focus();
        inputRef.current.select();
      }
    }
    window.addEventListener("keydown", handleF2);
    return () => window.removeEventListener("keydown", handleF2);
  }, [disabled, enableF2Shortcut]);

  const handleSelectItem = (item: PredictiveItem) => {
    playReadyBeep();
    onSelect(item);
    setSearchTerm("");
    setIsOpen(false);
    setHighlightedIndex(-1);
    inputRef.current?.focus();
  };

  const handleClear = () => {
    setSearchTerm("");
    setIsOpen(false);
    setHighlightedIndex(-1);
    onClear?.();
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || combinedResults.length === 0) {
      if (e.key === "Escape") {
        handleClear();
      } else if (e.key === "Enter" && searchTerm.trim()) {
        e.preventDefault();
        onBarcodeEnter?.(searchTerm.trim());
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < combinedResults.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : combinedResults.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && combinedResults[highlightedIndex]) {
        handleSelectItem(combinedResults[highlightedIndex]);
      } else if (onBarcodeEnter && searchTerm.trim()) {
        onBarcodeEnter(searchTerm.trim());
      } else if (combinedResults.length > 0 && combinedResults[0]) {
        handleSelectItem(combinedResults[0]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
      setHighlightedIndex(-1);
    }
  };

  const isSearching = serverQuery.isFetching;
  const activeDescendantId =
    isOpen && highlightedIndex >= 0 && combinedResults[highlightedIndex]
      ? `predictive-opt-${combinedResults[highlightedIndex].id}`
      : undefined;

  return (
    <div ref={containerRef} className={cn("relative w-full", className)} dir="rtl">
      {/* حقل الإدخال الأساسي الموحّد بتنسيق WAI-ARIA Combobox */}
      <UnifiedSearchInput
        ref={inputRef}
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-controls="predictive-consignment-listbox"
        aria-activedescendant={activeDescendantId}
        value={searchTerm}
        debounceMs={0}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(val) => setSearchTerm(val)}
        onScan={(code) => {
          if (onBarcodeEnter) {
            setIsOpen(false);
            setHighlightedIndex(-1);
            onBarcodeEnter(code);
          } else {
            setSearchTerm(code);
          }
        }}
        onFocus={() => {
          if (searchTerm.trim().length >= 2) setIsOpen(true);
        }}
        onKeyDown={handleKeyDown}
        className="w-full"
        inputClassName={cn("h-10 font-medium", inputClassName)}
      />

      {/* القائمة التنبؤية المنبثقة (Live Predictive Dropdown Listbox) */}
      {isOpen && (
        <div
          className={cn(
            "absolute z-50 mt-1.5 w-full rounded-xl border border-border bg-popover text-popover-foreground shadow-xl overflow-hidden",
            "animate-in fade-in-0 zoom-in-95 duration-150",
          )}
        >
          {combinedResults.length === 0 ? (
            <div
              role="status"
              aria-live="polite"
              className="p-4 text-center text-xs text-muted-foreground"
            >
              {isSearching ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 aria-hidden="true" className="size-4 animate-spin text-primary" />
                  <span>جارٍ البحث والتوقع في السجلات…</span>
                </div>
              ) : (
                <span>لا توجد نتائج مطابقة لـ &ldquo;{searchTerm.trim()}&rdquo;</span>
              )}
            </div>
          ) : (
            <div
              id="predictive-consignment-listbox"
              role="listbox"
              aria-label="نتائج البحث والتوقع الذكي"
              className="max-h-96 overflow-y-auto divide-y divide-border/60"
            >
              <div className="px-3 py-1.5 bg-muted/40 text-[11px] font-bold text-muted-foreground flex items-center justify-between">
                <span>نتائج التوقع الذكي ({combinedResults.length})</span>
                <span className="text-[10px]">استخدم الأسهم و Enter للاختيار</span>
              </div>

              {combinedResults.map((item, index) => (
                <PredictiveItemRow
                  key={item.id}
                  item={item}
                  isHighlighted={index === highlightedIndex}
                  onSelect={handleSelectItem}
                  onMouseEnter={() => setHighlightedIndex(index)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
