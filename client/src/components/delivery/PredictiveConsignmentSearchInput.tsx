/**
 * PredictiveConsignmentSearchInput — حقل البحث التنبؤي الذكي للطرود والإرساليات
 * 
 * الميزات الهندسية:
 * 1. يبحث بجزء من كم حرف (اسم الزبون أو العنوان) أو من كم رقم (هاتف، فاتورة، إرسالية، طلب).
 * 2. محرك هجين (Hybrid Engine): تصفية فورية 0ms للطرود المحملة بالذاكرة + استعلام خادمي ذكي عبر tRPC.
 * 3. قائمة تنبؤية فورية (Live Dropdown) تظهر تلقائياً عند كتابة حرفين أو رقمين فأكثر.
 * 4. إبراز شارات نوع التطابق: 📱 هاتف · 👤 زبون · 🧾 فاتورة · 📦 إرسالية · 📍 عنوان.
 * 5. ملاحة كاملة بلوحة المفاتيح: الأسهم Up/Down للتنقل، Enter للاختيار، Esc للإغلاق، F2 للتركيز.
 * 6. صون المسافات والكتابة العربية: لا استدعاء لـ trim() أثناء الكتابة الحية.
 * 7. التزام تام بهوية النظام البصرية وحراس الجودة والتعريب RTL وصفر إيموجي.
 */
import * as React from "react";
import {
  Building2,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  MapPin,
  Package,
  Phone,
  Search,
  Truck,
  User,
  X,
} from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { fmt } from "@/lib/money";
import { playReadyBeep } from "@/lib/notifyBeep";
import { cn } from "@/lib/utils";

export type PredictiveItem = RouterOutputs["delivery"]["predictiveSearch"][number];

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
  className?: string;
  inputClassName?: string;
  /** عند مسح الحقل */
  onClear?: () => void;
}

const PARCEL_STATUS_MAP: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  ASSIGNED: { label: "قيد الإسناد", variant: "outline" },
  ACCEPTED: { label: "مقبول", variant: "outline" },
  PICKED_UP: { label: "مستلم للتوصيل", variant: "secondary" },
  OUT_FOR_DELIVERY: { label: "بالطريق مع المندوب", variant: "default" },
  DELIVERED: { label: "مسلَّم للزبون", variant: "default" },
  FAILED: { label: "تعذّر التسليم", variant: "destructive" },
  RETURNED: { label: "مرتجع", variant: "destructive" },
  CANCELLED: { label: "ملغى", variant: "destructive" },
};

/** تسوية الحروف العربية للبحث الجزئي */
function normalizeArabic(text: string): string {
  return text
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .toLowerCase();
}

export function PredictiveConsignmentSearchInput({
  onSelect,
  onBarcodeEnter,
  partyId,
  localCandidates,
  placeholder = "بحث برقم الهاتف، اسم الزبون، رقم الفاتورة أو الإرسالية…",
  autoFocus = false,
  disabled = false,
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

    const digits = rawTrimmed.replace(/\D/g, "");
    const normQ = rawTrimmed.toLowerCase();
    const normAr = normalizeArabic(normQ);

    const map = new Map<number, PredictiveItem>();

    // ١. تصفية المرشحين المحليين فورياً (إذا وُجدوا)
    if (localCandidates && localCandidates.length > 0) {
      for (const row of localCandidates) {
        const phone = String(row.customerPhone ?? row.recipientPhone ?? "");
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
          const cod = Number(row.codAmount ?? 0);
          const collected = Number(row.collectedAmount ?? 0);
          const counter = Number(row.counterSettledAmount ?? 0);
          const shortfall = Number(row.shortfallAssigned ?? 0);
          const remaining = Math.max(0, cod - collected - counter - shortfall);

          const item: PredictiveItem = {
            id: Number(row.id),
            consignmentNumber: cn,
            externalTrackingRef: ext || null,
            invoiceId: row.invoiceId ? Number(row.invoiceId) : null,
            invoiceNumber: inv || null,
            workOrderId: row.workOrderId ? Number(row.workOrderId) : null,
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
            matchedOn: matchedOn.length > 0 ? matchedOn : ["CONSIGNMENT_NUMBER"],
            score: 1,
          };
          map.set(item.id, item);
        }
      }
    }

    // ٢. دمج نتائج الخادم
    if (serverQuery.data && serverQuery.data.length > 0) {
      for (const item of serverQuery.data) {
        if (!map.has(item.id)) {
          map.set(item.id, item);
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => (a.score ?? 2) - (b.score ?? 2) || b.id - a.id);
  }, [searchTerm, localCandidates, serverQuery.data, partyId]);

  // التحكم بظهور القائمة
  React.useEffect(() => {
    if (searchTerm.trim().length >= 2) {
      setIsOpen(true);
    } else {
      setIsOpen(false);
      setHighlightedIndex(-1);
    }
  }, [searchTerm]);

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
    function handleF2(e: KeyboardEvent) {
      if (e.key === "F2" && !disabled && inputRef.current) {
        e.preventDefault();
        inputRef.current.focus();
        inputRef.current.select();
      }
    }
    window.addEventListener("keydown", handleF2);
    return () => window.removeEventListener("keydown", handleF2);
  }, [disabled]);

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
      const target = highlightedIndex >= 0 ? combinedResults[highlightedIndex] : combinedResults[0];
      if (target) {
        handleSelectItem(target);
      } else if (searchTerm.trim()) {
        onBarcodeEnter?.(searchTerm.trim());
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
      setHighlightedIndex(-1);
    }
  };

  const isSearching = serverQuery.isFetching;

  return (
    <div ref={containerRef} className={cn("relative w-full", className)} dir="rtl">
      {/* حقل الإدخال الأساسي */}
      <div className="relative flex items-center w-full">
        {/* أيقونة البحث في البداية (اليمين في RTL) */}
        <span
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground flex items-center z-10"
        >
          {isSearching ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : (
            <Search className="size-4" />
          )}
        </span>

        <input
          ref={inputRef}
          type="text"
          value={searchTerm}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          enterKeyHint="search"
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            // لا استدعاء لـ trim() أثناء الكتابة الحية لصون المسافات
            setSearchTerm(e.target.value);
          }}
          onFocus={() => {
            if (searchTerm.trim().length >= 2) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-full h-10 rounded-xl border border-input bg-background pr-9 pl-9 text-sm font-medium",
            "outline-none transition-all duration-150",
            "focus:border-primary focus:ring-2 focus:ring-primary/20",
            "disabled:cursor-not-allowed disabled:opacity-50",
            inputClassName,
          )}
        />

        {/* زر المسح السريع X في النهاية (اليسار في RTL) */}
        {searchTerm.length > 0 && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="مسح البحث (Esc)"
            title="مسح البحث (Esc)"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground rounded p-1 transition-colors z-10 focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* القائمة التنبؤية المنبثقة (Live Predictive Dropdown) */}
      {isOpen && (
        <div
          className={cn(
            "absolute z-50 mt-1.5 w-full rounded-xl border border-border bg-popover text-popover-foreground shadow-xl overflow-hidden",
            "animate-in fade-in-0 zoom-in-95 duration-150",
          )}
        >
          {combinedResults.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              {isSearching ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin text-primary" />
                  <span>جارٍ البحث والتوقع في السجلات…</span>
                </div>
              ) : (
                <span>لا توجد نتائج مطابقة لـ &ldquo;{searchTerm.trim()}&rdquo;</span>
              )}
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto divide-y divide-border/60">
              <div className="px-3 py-1.5 bg-muted/40 text-[11px] font-bold text-muted-foreground flex items-center justify-between">
                <span>نتائج التوقع الذكي ({combinedResults.length})</span>
                <span className="text-[10px]">استخدم الأسهم و Enter للاختيار</span>
              </div>

              {combinedResults.map((item, index) => {
                const isHighlighted = index === highlightedIndex;
                const statusMeta = PARCEL_STATUS_MAP[item.parcelStatus] ?? { label: item.parcelStatus, variant: "outline" };
                const isCompany = item.partyType === "COMPANY";

                return (
                  <div
                    key={item.id}
                    onClick={() => handleSelectItem(item)}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={cn(
                      "p-3 cursor-pointer transition-colors text-xs space-y-1.5",
                      isHighlighted ? "bg-primary/10 text-foreground" : "hover:bg-muted/40",
                    )}
                  >
                    {/* السطر الأول: أرقام الطرد والفاتورة والشارات */}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-extrabold text-sm font-mono text-foreground flex items-center gap-1">
                          <Package className="size-3.5 text-primary shrink-0" />
                          {item.consignmentNumber}
                        </span>

                        {item.externalTrackingRef && (
                          <span className="font-bold text-xs text-primary font-mono bg-primary/10 px-1.5 py-0.5 rounded" dir="ltr">
                            {item.externalTrackingRef}
                          </span>
                        )}

                        {item.invoiceNumber && (
                          <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                            <FileText className="size-3" />
                            فاتورة #{item.invoiceNumber}
                          </span>
                        )}

                        {item.orderNumber && (
                          <span className="text-xs text-muted-foreground font-mono">
                            طلب #{item.orderNumber}
                          </span>
                        )}
                      </div>

                      {/* شارة حالة الطرد */}
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-background/80 text-foreground">
                        {statusMeta.label}
                      </span>
                    </div>

                    {/* السطر الثاني: اسم الزبون والهاتف والعنوان */}
                    <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <User className="size-3 shrink-0 text-muted-foreground" />
                        الزبون: <strong className="text-foreground">{item.customerName}</strong>
                      </span>

                      {item.customerPhone && (
                        <span className="inline-flex items-center gap-1 font-mono text-foreground font-semibold" dir="ltr">
                          <Phone className="size-3 text-muted-foreground shrink-0" />
                          <span>{item.customerPhone}</span>
                        </span>
                      )}

                      {item.deliveryAddress && (
                        <span className="inline-flex items-center gap-1 truncate max-w-[220px]" title={item.deliveryAddress}>
                          <MapPin className="size-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{item.deliveryAddress}</span>
                        </span>
                      )}
                    </div>

                    {/* السطر الثالث: جهة التوصيل والمبلغ المطلوب وشارات التطابق */}
                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40 text-[11px]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          {isCompany ? <Building2 className="size-3 shrink-0" /> : <Truck className="size-3 shrink-0" />}
                          <span>{item.partyName}</span>
                        </span>

                        {/* شارات نوع التطابق */}
                        {item.matchedOn?.map((kind) => {
                          if (kind === "PHONE") {
                            return (
                              <span key={kind} className="text-[10px] font-bold bg-emerald-500/10 text-emerald-700 px-1.5 py-0.2 rounded border border-emerald-500/30">
                                تطابق هاتف
                              </span>
                            );
                          }
                          if (kind === "CUSTOMER_NAME") {
                            return (
                              <span key={kind} className="text-[10px] font-bold bg-blue-500/10 text-blue-700 px-1.5 py-0.2 rounded border border-blue-500/30">
                                تطابق اسم
                              </span>
                            );
                          }
                          if (kind === "INVOICE_NUMBER") {
                            return (
                              <span key={kind} className="text-[10px] font-bold bg-purple-500/10 text-purple-700 px-1.5 py-0.2 rounded border border-purple-500/30">
                                تطابق فاتورة
                              </span>
                            );
                          }
                          if (kind === "CONSIGNMENT_NUMBER") {
                            return (
                              <span key={kind} className="text-[10px] font-bold bg-amber-500/10 text-amber-700 px-1.5 py-0.2 rounded border border-amber-500/30">
                                تطابق إرسالية
                              </span>
                            );
                          }
                          if (kind === "ADDRESS") {
                            return (
                              <span key={kind} className="text-[10px] font-bold bg-indigo-500/10 text-indigo-700 px-1.5 py-0.2 rounded border border-indigo-500/30">
                                تطابق عنوان
                              </span>
                            );
                          }
                          return null;
                        })}
                      </div>

                      <div className="text-end">
                        <span className="text-muted-foreground me-1">المطلوب (COD):</span>
                        <strong className="text-foreground font-mono font-bold">{fmt(item.remainingAmount)} د.ع</strong>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
