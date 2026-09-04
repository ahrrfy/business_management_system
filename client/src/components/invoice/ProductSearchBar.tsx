/**
 * ProductSearchBar — type-ahead product search + barcode resolver.
 *
 * - Live search via `trpc.catalog.posList` (for sale-side) or `catalog.forPurchase` (for purchase-side).
 * - Keyboard: ↑/↓ to navigate, Enter to add, Escape to close. Exact barcode match on Enter.
 * - When a scanner pastes a full barcode followed by Enter, we resolve via `catalog.byBarcode`
 *   (sale-side only). On purchase side, we fall back to substring match.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Camera, Search, X } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fmtNum } from "./totals";
import type { Currency, InvoiceLine, InvoiceType, PriceTier } from "./types";
import { useBarcodeInput } from "@/hooks/useBarcodeInput";
import { BarcodeSearchCue, barcodeSearchInputClass } from "@/components/scan/BarcodeSearchCue";
import { estimatedPurchaseUnitPrice } from "./purchasePrice";

export interface ProductSearchBarProps {
  invoiceType: InvoiceType;
  branchId: number;
  tier: PriceTier;
  onAddProduct: (line: InvoiceLine) => void;
  /** Optional callback for "not found" / errors. */
  onNotify?: (msg: string, kind: "error" | "info") => void;
  /**
   * Codex #980 (٤/٩/٢٦): عملةُ أمر الشراء وسعرُ تثبيته — يمرَّرا من `PurchaseNew`/`PurchaseEdit`
   * عبر `ProductTable`. الحقلان يخصّان جانب الشراء فقط، والقيم الافتراضية (`IQD`/`""`) تجعل
   * جانب البيع لا يتأثّر. `catalog.forPurchase.costPriceBase` يبقى بالدينار حتى للأمر الدولاريّ
   * ⇒ الفرع الدولاريّ يحتاج القسمةَ على `agreedRate`، وإلّا انتفخت ذمّةُ المورّد بمقداره.
   */
  purchaseCurrency?: Currency;
  purchaseAgreedRate?: string;
}

interface NormalizedRow {
  productId: number;
  variantId: number;
  productUnitId: number;
  name: string;
  sku: string;
  barcode: string | null;
  unitName: string;
  conversionFactor: string;
  stockBase: number;
  stockBranchId: number;
  reservedBase: number; // المحجوز النشط (الحجوزات) — 0 في جانب الشراء
  availableBase: number; // المتاح التشغيلي للبيع = max(0, stockBase − reservedBase)
  /** خدمة بلا مخزون ذاتيّ — createSale يوسّع وصفتها لخصم المواد. */
  isService: boolean;
  /** «يُباع بالطلب» (0318): صنفٌ مخزنيّ يقبله الخادم قبل توريده ⇒ لا يُوسَم نافداً. */
  allowBackorder: boolean;
  /** Sale price (sale side) OR cost (purchase side) — already in the unit, decimal string. */
  price: string;
  /** Cost in base unit (purchase side carries this; sale side gets it null when hidden). */
  costBase: string;
  category?: string | null;
}

function stockBadgeColor(stock: number): string {
  if (stock < 5) return "text-[var(--sem-neg)]";
  if (stock < 15) return "text-[var(--sem-warn)]";
  return "text-muted-foreground";
}

export function ProductSearchBar({ invoiceType, branchId, tier, onAddProduct, onNotify, purchaseCurrency = "IQD", purchaseAgreedRate = "" }: ProductSearchBarProps) {
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  const branchesQ = trpc.branches.list.useQuery();
  const branchLabel = (id: number) => branchesQ.data?.find((b) => Number(b.id) === id)?.name ?? `فرع #${id}`;
  // فاتورة بيع متقدّمة (١٢/٨/٢٦): تُظهر كل خدمات الطباعة بلا شرط showInReception، لأنّ الفاتورة
  // الرسمية قد تضمّ سلعاً وخدماتٍ في نفس المستند (شركات/حكومي). createSale يخصم موادها ذرّياً.
  const isAdvancedSale = invoiceType === "SALE";

  const [query, setQuery] = useState("");
  const [showDrop, setShowDrop] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // بحث ذكي: تأجيل ١٨٠ms (طلب واحد بعد استقرار الكتابة لا مع كل حرف) + إبقاء النتائج
  // السابقة أثناء الجلب (لا وميض) + التفعيل من حرفين. التطبيع العربي والترتيب على الخادم.
  const debounced = useDebouncedValue(query, 180);
  const term = debounced.trim();
  const canSearch = term.length >= 2;
  // Sale-side query
  const posQ = trpc.catalog.posList.useQuery(
    { branchId, tier, query: term, limit: 50, includeAllServices: isAdvancedSale },
    { enabled: !isPurchase && canSearch, placeholderData: keepPreviousData, staleTime: 0 }
  );
  // Purchase-side query
  const purQ = trpc.catalog.forPurchase.useQuery(
    { branchId, query: term, limit: 50 },
    { enabled: isPurchase && canSearch, placeholderData: keepPreviousData, staleTime: 15_000 }
  );
  /** النتائج مطابقة للنص الحالي (لا تأجيل ولا جلب معلّق وطوله صالح) ⇒ Enter يضيف بأمان */
  const settled =
    term === query.trim() && query.trim().length >= 2 && !(isPurchase ? purQ.isFetching : posQ.isFetching);

  const utils = trpc.useUtils();

  // ما يُعرض/يُبحر فيه: عند النزول تحت حرفين تُخفى النتائج القديمة العالقة (keepPreviousData)
  // كي لا تُعرض مضلِّلةً ولا يضيفها Enter/الأسهم خطأً.
  const results: NormalizedRow[] = useMemo(() => {
    if (query.trim().length < 2) return [];
    if (isPurchase) {
      return (purQ.data ?? []).map((r) => ({
        productId: r.productId,
        variantId: r.variantId,
        productUnitId: r.productUnitId,
        name: r.productName + (r.variantName ? ` — ${r.variantName}` : ""),
        sku: r.sku,
        barcode: null,
        unitName: r.unitName,
        conversionFactor: r.conversionFactor,
        stockBase: r.stockBase ?? 0,
        stockBranchId: branchId,
        reservedBase: 0, // الشراء لا يعنيه المحجوز
        availableBase: r.stockBase ?? 0,
        isService: false,
        allowBackorder: false, // جانب الشراء لا يعنيه وسمُ البيع بالطلب.
        // PUR-UNIT-01 (٤/٩/٢٦): سعر شراء الوحدة **تقديريّاً** = تكلفة الأساس × المعامل.
        // كان الحقلان يُملآن معاً بـcostPriceBase (بوحدة الأساس)، فدرزنٌ (معامل ١٢) بتكلفة
        // ١٥٠/قطعة يُضاف بسعرِ ١٥٠/درزن ⇒ يقسم الخادم على ١٢ فيصير `costPerBase = 12.50`
        // ويسمّم WAVG. المساعد المشترك يفصل: `price` بوحدة الصفّ، `costBase` مرجعُ الأساس.
        // Codex #980 (٤/٩/٢٦): الفرع الدولاريّ يقسم على سعر التثبيت، وبلا تثبيتٍ يترك الحقل
        // فارغاً حتى يضبطه المستخدم يدوياً (لا يضع رقماً دينارياً في حقل دولار).
        price: estimatedPurchaseUnitPrice(r.costPriceBase, r.conversionFactor, isPurchase ? purchaseCurrency : "IQD", isPurchase ? purchaseAgreedRate : null),
        costBase: r.costPriceBase,
      }));
    }
    return (posQ.data ?? []).map((r) => ({
      productId: r.productId,
      variantId: r.variantId,
      productUnitId: r.productUnitId,
      name: r.productName + (r.variantName ? ` — ${r.variantName}` : ""),
      sku: r.sku,
      barcode: r.barcode ?? null,
      unitName: r.unitName,
      conversionFactor: r.conversionFactor,
      stockBase: r.stockBase ?? 0,
      stockBranchId: r.branchId,
      reservedBase: r.reservedBase ?? 0,
      availableBase: r.availableBase ?? (r.stockBase ?? 0),
      isService: r.isService || r.isPrintService,
      allowBackorder: r.allowBackorder === true,
      price: r.price ?? "0",
      // التكلفة تصل من الخادم (`catalog.posList`) للمستخدم المخوَّل برؤيتها (مدير/أدمن)، ويُحجب
      // إلى null لغير المخوَّلين (كاشير) في `catalogRouter.redactPosCost` قبل الإرسال ⇒ لا تسرب.
      // شاشات المبيعات المتقدّمة (`SalesInvoiceNew`) تعرض عمود «التكلفة» و«الهامش٪» بهذه القيمة.
      costBase: r.costPriceBase ?? "0",
    }));
  }, [isPurchase, posQ.data, purQ.data, query, purchaseCurrency, purchaseAgreedRate]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowDrop(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  useEffect(() => {
    // تظهر القائمة دائماً مع نصّ بحث (نتائج أو حالة واضحة: قصير/جارٍ/لا نتائج) — لا صمت
    setShowDrop(query.trim().length > 0);
    setSelectedIdx(-1);
  }, [results, query]);

  const addRow = (r: NormalizedRow) => {
    const line: InvoiceLine = {
      productId: r.productId,
      variantId: r.variantId,
      productUnitId: r.productUnitId,
      name: r.name,
      sku: r.sku,
      barcode: r.barcode,
      unit: r.unitName,
      qty: 1,
      conversionFactor: r.conversionFactor,
      stockBase: r.stockBase,
      stockBranchId: r.stockBranchId,
      reservedBase: r.reservedBase,
      availableBase: r.availableBase,
      isService: r.isService,
      allowBackorder: r.allowBackorder,
      price: r.price || "0",
      costBase: r.costBase || "0",
      discount: "0",
      discountType: "percent",
      note: "",
    };
    onAddProduct(line);
    setQuery("");
    setShowDrop(false);
    inputRef.current?.focus();
  };

  async function resolveExactBarcode(code: string) {
    // جانب الشراء لا يملك byBarcode؛ نملأ النص المصحّح ليعمل البحث الخادميّ المعتاد.
    if (isPurchase) {
      setQuery(code);
      setShowDrop(true);
      return;
    }
    try {
      const row = await utils.catalog.byBarcode.fetch({ barcode: code, branchId, tier });
      if (row) {
        addRow({
          productId: row.productId,
          variantId: row.variantId,
          productUnitId: row.productUnitId,
          name: row.productName + (row.variantName ? ` — ${row.variantName}` : ""),
          sku: row.sku,
          barcode: row.barcode ?? null,
          unitName: row.unitName,
          conversionFactor: row.conversionFactor,
          stockBase: row.stockBase ?? 0,
          stockBranchId: row.branchId,
          reservedBase: row.reservedBase ?? 0,
          availableBase: row.availableBase ?? (row.stockBase ?? 0),
          isService: row.isService || row.isPrintService,
          allowBackorder: row.allowBackorder === true,
          price: row.price ?? "0",
          costBase: "0",
        });
        return;
      }
      onNotify?.(`الباركود غير معروف: ${code}`, "error");
    } catch {
      onNotify?.("تعذّر الاتصال بالخادم", "error");
    }
  }

  const barcodeInput = useBarcodeInput((code) => { void resolveExactBarcode(code); });

  const handleKey = async (e: KeyboardEvent<HTMLInputElement>) => {
    barcodeInput.handleKeyDown(e, setQuery);
    if (e.defaultPrevented) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIdx >= 0 && results[selectedIdx]) {
        addRow(results[selectedIdx]);
        return;
      }
      // أثناء التأجيل/الجلب النتائج قد تعود لاستعلام أقدم ⇒ لا نضيف خطأً (انتظر ~٢٠٠ms واضغط من جديد)
      if (settled && results.length >= 1) {
        addRow(results[0]);
        return;
      }
      // Try exact barcode resolution (sale side only — has byBarcode endpoint).
      // فقط لما يشبه باركوداً (أرقام/لاتيني متصل ≥4) — نصّ بحث عربي عادي لا يُرمى عليه
      // «باركود غير معروف»؛ رسالة «لا نتائج» تظهر في القائمة نفسها.
      const code = query.trim();
      const looksLikeBarcode = /^[0-9A-Za-z_-]{4,}$/.test(code);
      if (code && !isPurchase && looksLikeBarcode) {
        await resolveExactBarcode(code);
      }
    } else if (e.key === "Escape") {
      setShowDrop(false);
      setQuery("");
    }
  };

  const loading = (isPurchase ? purQ.isFetching : posQ.isFetching) && query.trim().length > 0;

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative w-full min-w-0 flex-1 sm:min-w-72">
          {/* توحيد بصريّ (٢٥/٨): استعمال `barcodeSearchInputClass` + `<BarcodeSearchCue />` كنمطٍ موحَّد
              عبر كلّ الشاشات (Reception/PrintPOS/POS/Bundle/Studio/Production/WorkOrders).
              ملاحظة: الشارة مثبَّتة على `right-2` **فيزيائياً** (لا logical)، والمستنَد RTL:
                • `right-*` (physical) = `start-*` (logical) في RTL ⇒ نفس الجانب البصريّ ⇒ تضارب.
              فأيقونة البحث + زرّ المسح على `end-*` (logical) لينحسبا للجانب المقابل بصرياً
              (اليسار في RTL)، مع `pe-10` padding للجانب نفسه. Codex #777 أمسك التضارب الأصليّ. */}
          <span aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            <Search aria-hidden className="size-4" />
          </span>
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            onFocus={() => {
              if (results.length > 0) setShowDrop(true);
            }}
            placeholder="ابحث بالاسم أو SKU أو امسح الباركود..."
            className={`h-11 pe-10 text-sm ${barcodeSearchInputClass}`}
            aria-label="بحث المنتجات"
          />
          {query && (
            <button
              type="button"
              aria-label="مسح"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute end-9 top-1/2 -translate-y-1/2 rounded-md p-1 text-sm text-muted-foreground hover:bg-muted"
            >
              <X aria-hidden className="size-4" />
            </button>
          )}
          <BarcodeSearchCue />
        </div>
        <div className="flex w-full shrink-0 gap-2 sm:w-auto">
          <div className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-primary/50 bg-primary/10 px-3 text-xs font-bold text-primary sm:flex-none">
            <Camera aria-hidden className="size-4" /> قارئ باركود
          </div>
          <div className="flex shrink-0 items-center rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-muted-foreground">F2 للبحث</div>
        </div>
      </div>

      {showDrop && (
        <div className="absolute inset-x-0 top-[calc(100%+4px)] z-40 overflow-hidden rounded-xl border bg-card shadow-xl">
          {query.trim().length < 2 && (
            <div className="px-4 py-3 text-center text-xs text-muted-foreground">اكتب حرفين فأكثر للبحث…</div>
          )}
          {query.trim().length >= 2 && results.length === 0 && (
            <div className="px-4 py-3 text-center text-xs text-muted-foreground">
              {loading ? "جارٍ البحث…" : <>لا نتائج لـ «{query.trim()}» — جرّب كلمة أقصر أو امسح الباركود</>}
            </div>
          )}
          {/* النتائج السابقة تبقى ظاهرة أثناء الجلب (باهتة قليلاً) — لا وميض اختفاء */}
          <div className={cn("max-h-80 overflow-auto", loading && "opacity-60")}>
          {results.map((p, i) => (
              <div
                key={p.productUnitId}
                onClick={() => addRow(p)}
                className={cn(
                  "grid cursor-pointer grid-cols-[1fr_auto] gap-3 border-b px-4 py-2.5 last:border-b-0 transition",
                  i === selectedIdx ? "bg-primary/10" : "hover:bg-muted"
                )}
              >
                <div>
                  <div className="text-sm font-bold text-foreground">
                    {p.name}
                    {p.isService && (
                      <span className="ms-2 rounded-full bg-[var(--sem-pos-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--sem-pos)]">خدمة</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span>{p.sku}</span>
                    <span>•</span>
                    <span>{p.unitName}</span>
                    <span>•</span>
                    <span>الفرع: {branchLabel(p.stockBranchId)}</span>
                    <span>•</span>
                    {p.isService ? (
                      <span>بلا مخزون ذاتيّ (تُخصَم موادها)</span>
                    ) : (
                      <>
                        <span>فعلي: {fmtNum(p.stockBase)}</span>
                        <span>•</span>
                        <span className={stockBadgeColor(p.availableBase)}>متاح للبيع: {fmtNum(p.availableBase)}</span>
                        {p.reservedBase > 0 && (
                          <>
                            <span>•</span>
                            <span className="text-[var(--sem-warn)]">محجوز: {fmtNum(p.reservedBase)}</span>
                            {p.reservedBase > p.stockBase && (
                              <>
                                <span>•</span>
                                <span>زيادة حجز: {fmtNum(p.reservedBase - p.stockBase)}</span>
                              </>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end justify-center">
                  <div dir="ltr" className="text-base font-extrabold text-primary">
                    {fmtNum(p.price)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    د.ع / {p.unitName}
                    {/* PUR-UNIT-01: على جانب الشراء السعر مشتقٌّ من آخر تكلفةٍ × معامل الوحدة —
                        ليست ورقة المورّد. الوسم يُعلم المستعمل أنّه قابل للتعديل قبل الإرسال. */}
                    {isPurchase && (
                      <span className="ms-1 rounded bg-muted px-1 py-0.5 text-[9px] font-bold text-muted-foreground">
                        تقديريّ
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
