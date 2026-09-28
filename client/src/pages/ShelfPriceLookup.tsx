/**
 * ShelfPriceLookup — واجهة الجوال لاستعلام أسعار الرفوف بالباركود (QR Shelf Price Lookup).
 *
 * صفحة ويب عامة وخفيفة (PWA Mobile-First) تتيح لزوار المعرض والمكتبة مسح باركود أي
 * منتج على الرف بكاميرا هاتفهم، والحصول فوراً على السعر المعتمد بالدينار العراقي (IQD)،
 * العروض الترويجية الحية، الوحدات والعبوات المتوفرة، والمنتجات المكملة، بلا حاجة لتثبيت
 * أي تطبيق أو تسجيل دخول.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Barcode,
  Camera,
  CheckCircle2,
  ChevronLeft,
  Flame,
  Layers,
  Package,
  RefreshCw,
  ScanLine,
  Search,
  ShoppingBag,
  Sparkles,
  Tag,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { CameraScanner } from "@/components/scan/CameraScanner";
import { normalizeBarcodeScannerInput } from "@/lib/barcodeScannerInput";
import { fmtAr, formatIqd } from "@/lib/money";
import { playScanNotFound, playScanSuccess } from "@/lib/audioFeedback";
import { trpc } from "@/lib/trpc";
import { ACTION_LABELS } from "@shared/actionLabels";

/** خيار الوحدة البديلة للصنف (قطعة / علبة / كرتون). */
export interface ShelfUnitOption {
  unitName: string;
  conversionFactor: number;
  price: string | null;
  barcode: string | null;
}

/** منتج مقترح للشراء المكمل (Cross-sell). */
export interface ShelfRelatedProduct {
  productId: number;
  productName: string;
  price: string | null;
  salePrice: string | null;
  promotionName: string | null;
  imageUrl: string | null;
  inStock: boolean;
}

/** نتيجة استعلام السعر الناجحة من الخادم. */
export interface ShelfLookupSuccess {
  found: true;
  productId: number;
  productUnitId: number;
  productName: string;
  brand: string | null;
  category: string | null;
  unitName: string;
  barcode: string;
  price: string | null;
  originalPrice?: string | null;
  discountPercent?: string | null;
  promotionName?: string | null;
  inStock: boolean;
  imageUrl: string | null;
  availableUnits?: ShelfUnitOption[];
  relatedProducts?: ShelfRelatedProduct[];
}

/** نتيجة عدم العثور على الصنف. */
export interface ShelfLookupNotFound {
  found: false;
  reason: "NOT_FOUND" | "AMBIGUOUS";
  barcode?: string;
}

export type ShelfLookupResponse = ShelfLookupSuccess | ShelfLookupNotFound;

/** استخراج الباركود النظيف سواء كان مدخلاً مجرداً أو رابطاً مشفراً في رمز QR. */
function extractBarcodeFromInput(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const codeParam = url.searchParams.get("code") || url.searchParams.get("barcode") || url.searchParams.get("sku");
      if (codeParam) return normalizeBarcodeScannerInput(codeParam);
      const parts = url.pathname.split("/").filter(Boolean);
      const last = parts[parts.length - 1];
      if (last && /^[A-Za-z0-9_-]+$/.test(last) && last !== "shelf-lookup") {
        return normalizeBarcodeScannerInput(last);
      }
    } catch {
      // ليس رابطاً صالحاً
    }
  }
  return normalizeBarcodeScannerInput(trimmed);
}

/** استخراج بارامترات البحث من رابط الصفحة. */
function parseUrlParams(): { branchId?: number; initialBarcode?: string } {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const branchRaw = params.get("branch") || params.get("branchId");
  const branchId = branchRaw && !Number.isNaN(Number(branchRaw)) ? Number(branchRaw) : undefined;
  const barcodeParam = params.get("code") || params.get("barcode");
  const initialBarcode = barcodeParam ? extractBarcodeFromInput(barcodeParam) : undefined;
  return { branchId, initialBarcode };
}

let memoryVisitorId: string | null = null;

function getPersistentVisitorId(): string {
  if (typeof window === "undefined") return "anon";
  try {
    const key = "shelf_lookup_vid";
    let vid = localStorage.getItem(key);
    if (!vid || vid.length < 10) {
      vid = `vst_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
      localStorage.setItem(key, vid);
    }
    return vid;
  } catch {
    if (!memoryVisitorId) {
      memoryVisitorId = `vst_mem_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    }
    return memoryVisitorId;
  }
}

function detectDeviceType(): "ios" | "android" | "desktop" {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/android/i.test(ua)) return "android";
  return "desktop";
}

export default function ShelfPriceLookup() {
  const [, setLocation] = useLocation();
  const { branchId, initialBarcode } = useMemo(() => parseUrlParams(), []);
  const visitorId = useMemo(() => getPersistentVisitorId(), []);
  const deviceType = useMemo(() => detectDeviceType(), []);

  // إدارة حالة الباركود والماسح
  const [barcode, setBarcode] = useState<string | null>(initialBarcode ?? null);
  const [scannerOpen, setScannerOpen] = useState<boolean>(!initialBarcode);
  const [manualInputOpen, setManualInputOpen] = useState<boolean>(false);
  const [manualInputValue, setManualInputValue] = useState<string>("");
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [selectedUnitIndex, setSelectedUnitIndex] = useState<number>(0);

  // استدعاء tRPC لاستعلام سعر الصنف الممسوح وحصر المستفيدين
  const lookupQuery = trpc.storefront.shelfLookup.useQuery(
    {
      barcode: barcode ?? "",
      branchId,
      visitorId,
      deviceType,
    },
    {
      enabled: Boolean(barcode),
      staleTime: 15_000,
      retry: 1,
    }
  );

  const lookupData = lookupQuery?.data as ShelfLookupResponse | undefined;
  const isLoading = Boolean(lookupQuery?.isLoading && barcode);
  const isError = Boolean(lookupQuery?.isError);

  // عند تغيّر الصنف الممسوح، إعادة تعيين مؤشر الوحدة المحددة
  useEffect(() => {
    setSelectedUnitIndex(0);
  }, [barcode]);

  // تغذية صوتية عند عدم العثور
  useEffect(() => {
    if (lookupData && !lookupData.found && barcode) {
      playScanNotFound(isMuted);
    }
  }, [lookupData, isMuted, barcode]);

  // معالجة التقاط باركود جديد عبر الكاميرا أو الإدخال اليدوي
  const handleDetectBarcode = useCallback(
    (scannedCode: string) => {
      const cleanCode = extractBarcodeFromInput(scannedCode);
      if (!cleanCode) return;

      // اهتزاز لمسي تأكيدي لطيف على الهواتف الذكية
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try {
          navigator.vibrate([40, 30, 40]);
        } catch {
          // إخفاق صامت على المتصفحات غير الداعمة
        }
      }

      // رنة نجاح صوتية
      playScanSuccess(isMuted);

      setBarcode(cleanCode);
      setScannerOpen(false);
      setManualInputOpen(false);
    },
    [isMuted]
  );

  // معالجة إرسال نموذج الإدخال اليدوي
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInputValue.trim()) return;
    handleDetectBarcode(manualInputValue);
    setManualInputValue("");
  };

  // بيانات السلعة المطابقة
  const product = lookupData?.found ? lookupData : null;
  const availableUnits = product?.availableUnits ?? [];
  const activeUnit = availableUnits.length > 0 && availableUnits[selectedUnitIndex]
    ? availableUnits[selectedUnitIndex]
    : null;

  // السعر الفعلي المعروض بحسب الوحدة المختارة
  const displayedPrice = activeUnit ? activeUnit.price : product?.price;
  const originalPrice = product?.originalPrice;
  const hasDiscount = Boolean(originalPrice && displayedPrice && originalPrice !== displayedPrice);
  const discountSavings = useMemo(() => {
    if (!hasDiscount || !originalPrice || !displayedPrice) return null;
    const orig = Number(originalPrice);
    const curr = Number(displayedPrice);
    return orig > curr ? orig - curr : null;
  }, [hasDiscount, originalPrice, displayedPrice]);

  return (
    <div
      dir="rtl"
      className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col font-sans select-none"
    >
      {/* ── شريط الرأس العصري للهواتف (App Bar) ── */}
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center justify-between shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className="size-9 rounded-xl bg-gradient-to-tr from-primary to-primary/80 flex items-center justify-center text-white shadow-xs">
            <ScanLine className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-black text-sm tracking-tight text-slate-900 dark:text-white">
                الرؤية العربية
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-primary/10 text-primary">
                استعلام الرف
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-none mt-0.5">
              {branchId === 2 ? "فرع المبيعات" : branchId === 1 ? "الفرع الرئيسي" : "معرض المكتبة"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* زر كتم / تفعيل الصوت */}
          <button
            type="button"
            onClick={() => setIsMuted((prev) => !prev)}
            className="size-9 rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title={isMuted ? "تشغيل التنبيه الصوتي" : "كتم التنبيه الصوتي"}
            aria-label={isMuted ? "تشغيل التنبيه الصوتي" : "كتم التنبيه الصوتي"}
          >
            {isMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </button>

          {/* زر فتح حوار الإدخال اليدوي */}
          <button
            type="button"
            onClick={() => setManualInputOpen(true)}
            className="size-9 rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="إدخال الباركود يدوياً"
            aria-label="إدخال الباركود يدوياً"
          >
            <Barcode className="size-4" />
          </button>

          {/* زر تشغيل الكاميرا الفوري */}
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full bg-primary text-white text-xs font-bold hover:bg-primary/90 transition-all shadow-xs active:scale-95"
            aria-label="مسح بالكاميرا"
          >
            <Camera className="size-4" />
            <span>مسح</span>
          </button>
        </div>
      </header>

      {/* ── محتوى الصفحة الرئيسي ── */}
      <main className="flex-1 flex flex-col p-4 max-w-lg mx-auto w-full">
        {/* في حال جاري التحميل */}
        {isLoading && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center animate-pulse">
            <div className="size-16 rounded-2xl bg-primary/10 flex items-center justify-center text-primary mb-4">
              <RefreshCw className="size-8 animate-spin" />
            </div>
            <p className="font-bold text-base text-slate-800 dark:text-slate-200">
              {ACTION_LABELS.loading}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              جارٍ قراءة الباركود ومطابقة السعر المعتمد...
            </p>
          </div>
        )}

        {/* في حال وجود خطأ بالاتصال */}
        {!isLoading && isError && (
          <div className="bg-[var(--sem-neg-bg)] border border-[var(--sem-neg)]/30 rounded-2xl p-5 text-center my-auto">
            <div className="size-12 rounded-full bg-[var(--sem-neg)]/10 text-[var(--sem-neg)] flex items-center justify-center mx-auto mb-3">
              <AlertCircle className="size-6" />
            </div>
            <h3 className="font-bold text-base text-[var(--sem-neg)]">
              تعذّر استعلام السعر
            </h3>
            <p className="text-xs text-[var(--sem-neg)]/80 mt-1 leading-relaxed">
              يرجى التأكد من اتصال الهاتف بالإنترنت والمحاولة مجدداً.
            </p>
            <button
              type="button"
              onClick={() => lookupQuery?.refetch()}
              className="mt-4 inline-flex items-center gap-2 h-10 px-5 rounded-xl bg-destructive hover:bg-destructive/90 text-destructive-foreground text-xs font-bold transition-all shadow-xs"
            >
              <RefreshCw className="size-3.5" />
              <span>{ACTION_LABELS.retry}</span>
            </button>
          </div>
        )}

        {/* في حال لم يتم العثور على الباركود */}
        {!isLoading && !isError && lookupData && !lookupData.found && (
          <div className="bg-[var(--sem-warn-bg)] border border-[var(--sem-warn)]/30 rounded-3xl p-6 text-center my-auto shadow-xs">
            <div className="size-14 rounded-2xl bg-[var(--sem-warn)]/15 text-[var(--sem-warn)] flex items-center justify-center mx-auto mb-3.5">
              <AlertCircle className="size-7" />
            </div>
            <h3 className="font-extrabold text-lg text-foreground">
              الصنف غير متوفر في النظام
            </h3>
            <div className="inline-block mt-2 px-3 py-1 rounded-lg bg-[var(--sem-warn)]/15 font-mono text-xs font-bold text-[var(--sem-warn)]">
              {barcode}
            </div>
            <p className="text-xs text-muted-foreground mt-3 leading-relaxed max-w-xs mx-auto">
              لم نعثر على هذا الباركود في قاعدة بيانات المعرض، أو قد يكون باركوداً لم يدخل الخدمة بعد. يسعدنا استفسارك من موظف المعرض.
            </p>
            <div className="mt-6 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="w-full h-12 rounded-xl bg-primary hover:bg-primary/95 text-white text-sm font-bold flex items-center justify-center gap-2 shadow-xs transition-transform active:scale-[0.98]"
              >
                <Camera className="size-4" />
                <span>مسح باركود آخر</span>
              </button>
              <button
                type="button"
                onClick={() => setManualInputOpen(true)}
                className="w-full h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 text-xs font-bold flex items-center justify-center gap-2 hover:bg-slate-50 transition-colors"
              >
                <Search className="size-4" />
                <span>كتابة الباركود يدوياً</span>
              </button>
            </div>
          </div>
        )}

        {/* في حال العثور على الصنف بنجاح (بطاقة عرض النتيجة) */}
        {!isLoading && !isError && product && (
          <div className="flex-1 flex flex-col justify-between pb-6">
            <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 p-5 shadow-sm space-y-4">
              {/* قسم صورة المنتج والوسوم */}
              <div className="flex items-start gap-4">
                <div className="relative size-24 shrink-0 rounded-2xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 overflow-hidden flex items-center justify-center">
                  {product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt={product.productName}
                      className="size-full object-contain p-1.5"
                      loading="lazy"
                    />
                  ) : (
                    <Package className="size-8 text-slate-400" />
                  )}
                  {hasDiscount && (
                    <div className="absolute top-1 right-1 rounded-md bg-destructive text-destructive-foreground text-[9px] font-black px-1.5 py-0.5 shadow-xs">
                      عرض
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  {/* الفئة والماركة */}
                  <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                    {product.category && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                        <Tag className="size-2.5" />
                        {product.category}
                      </span>
                    )}
                    {product.brand && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary">
                        <Sparkles className="size-2.5" />
                        {product.brand}
                      </span>
                    )}
                  </div>

                  {/* اسم المنتج */}
                  <h2 className="text-base font-extrabold text-slate-900 dark:text-white leading-snug line-clamp-2">
                    {product.productName}
                  </h2>

                  {/* حالة التوفر في المعرض */}
                  <div className="mt-2 flex items-center gap-1.5">
                    {product.inStock ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-stock-ok">
                        <CheckCircle2 className="size-3.5" />
                        متوفر في المعرض
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-stock-low">
                        <AlertCircle className="size-3.5" />
                        الكمية محدودة / غير متوفر
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* قسم السعر الرئيسي بالدينار العراقي */}
              <div className="bg-gradient-to-r from-primary/5 via-primary/10 to-transparent p-4 rounded-2xl border border-primary/20 flex flex-col gap-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    السعر المعتمد:
                  </span>
                  {hasDiscount && originalPrice && (
                    <span className="text-xs text-slate-400 line-through font-mono">
                      {formatIqd(originalPrice)}
                    </span>
                  )}
                </div>

                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-black text-primary tracking-tight font-mono">
                    {fmtAr(displayedPrice)}
                  </span>
                  <span className="text-sm font-bold text-slate-600 dark:text-slate-300">
                    د.ع
                  </span>
                  <span className="text-xs text-slate-500 mr-auto font-medium">
                    / {activeUnit?.unitName ?? product.unitName}
                  </span>
                </div>

                {/* شارة التوفير إن وجد تخفيض */}
                {hasDiscount && discountSavings != null && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs font-extrabold text-money-negative">
                    <Flame className="size-3.5 shrink-0" />
                    <span>وفر {fmtAr(discountSavings)} د.ع اليوم</span>
                    {product.promotionName && (
                      <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                        ({product.promotionName})
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* مبدل العبوات والوحدات البديلة (إن وجدت) */}
              {availableUnits.length > 1 && (
                <div className="space-y-2 pt-1 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-300">
                    <Layers className="size-3.5 text-primary" />
                    <span>العبوات والوحدات المتوفرة:</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {availableUnits.map((unit, idx) => {
                      const isSelected = idx === selectedUnitIndex;
                      return (
                        <button
                          key={unit.unitName + idx}
                          type="button"
                          onClick={() => setSelectedUnitIndex(idx)}
                          className={`p-2.5 rounded-xl text-right transition-all border ${
                            isSelected
                              ? "bg-primary/10 border-primary text-primary font-bold shadow-xs"
                              : "bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-slate-300"
                          }`}
                        >
                          <div className="text-xs font-extrabold">{unit.unitName}</div>
                          <div className="text-[11px] font-mono mt-0.5 text-slate-500 dark:text-slate-400">
                            {formatIqd(unit.price)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* الباركود ورقم الصنف */}
              <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 font-mono border-t border-slate-100 dark:border-slate-800">
                <span>باركود: {activeUnit?.barcode || product.barcode}</span>
                <span>رقم الصنف: #{product.productId}</span>
              </div>
            </div>

            {/* شريط المنتجات المقترحة ذات الصلة (Cross-sell) */}
            {product.relatedProducts && product.relatedProducts.length > 0 && (
              <div className="mt-5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-extrabold text-slate-800 dark:text-slate-200">
                    <Sparkles className="size-3.5 text-primary" />
                    <span>يُشترى معه غالباً</span>
                  </div>
                  <span className="text-[10px] text-slate-400">خيارات مكملة</span>
                </div>

                <div className="flex gap-2.5 overflow-x-auto pb-2 pt-1 -mx-4 px-4 scrollbar-none">
                  {product.relatedProducts.map((rel) => (
                    <div
                      key={rel.productId}
                      className="w-36 shrink-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-2.5 flex flex-col justify-between shadow-2xs hover:border-primary/50 transition-colors cursor-pointer"
                      onClick={() => setLocation(`/store/product/${rel.productId}`)}
                    >
                      <div className="aspect-square w-full rounded-xl bg-slate-50 dark:bg-slate-800 overflow-hidden mb-2 flex items-center justify-center">
                        {rel.imageUrl ? (
                          <img
                            src={rel.imageUrl}
                            alt={rel.productName}
                            className="size-full object-contain p-1"
                            loading="lazy"
                          />
                        ) : (
                          <Package className="size-6 text-slate-400" />
                        )}
                      </div>
                      <h4 className="text-[11px] font-bold text-slate-800 dark:text-slate-200 line-clamp-2 leading-tight">
                        {rel.productName}
                      </h4>
                      <div className="mt-1.5 text-xs font-black text-primary font-mono">
                        {formatIqd(rel.salePrice ?? rel.price)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* أزرار الإجراءات السريعة (مسح منتج آخر + عرض بالمتجر) */}
            <div className="mt-6 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="w-full h-12 rounded-2xl bg-primary hover:bg-primary/95 text-white text-sm font-extrabold flex items-center justify-center gap-2 shadow-xs transition-transform active:scale-[0.98]"
              >
                <RefreshCw className="size-4" />
                <span>مسح منتج آخر</span>
              </button>

              <button
                type="button"
                onClick={() => setLocation(`/store/product/${product.productId}`)}
                className="w-full h-11 rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 text-xs font-bold flex items-center justify-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-850 transition-colors"
              >
                <ShoppingBag className="size-4 text-primary" />
                <span>عرض في المتجر الإلكتروني</span>
                <ChevronLeft className="size-4 mr-auto" />
              </button>
            </div>
          </div>
        )}

        {/* في حال عدم وجود أي باركود ممسوح والماسح مغلق (شاشة الترحيب) */}
        {!isLoading && !lookupData && !barcode && (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-4 my-auto">
            <div className="size-20 rounded-3xl bg-primary/10 text-primary flex items-center justify-center mb-5 shadow-xs">
              <ScanLine className="size-10" />
            </div>

            <h2 className="text-xl font-black text-slate-900 dark:text-white">
              قارئ أسعار الرفوف
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 max-w-xs leading-relaxed">
              وجّه كاميرا هاتفك إلى باركود أي سلعة أو كتاب أو دفتر في المعرض لعرض السعر الدقيق والعروض الفعّالة فوراً.
            </p>

            <button
              type="button"
              onClick={() => setScannerOpen(true)}
              className="mt-8 w-full max-w-xs h-13 rounded-2xl bg-primary hover:bg-primary/95 text-white text-base font-extrabold flex items-center justify-center gap-2.5 shadow-md shadow-primary/20 transition-transform active:scale-95"
            >
              <Camera className="size-5" />
              <span>تشغيل الكاميرا والمسح</span>
            </button>

            <button
              type="button"
              onClick={() => setManualInputOpen(true)}
              className="mt-3 text-xs font-bold text-slate-500 hover:text-primary transition-colors flex items-center gap-1.5 py-2 px-3"
            >
              <Search className="size-3.5" />
              <span>أو اكتب رقم الباركود يدوياً</span>
            </button>
          </div>
        )}
      </main>

      {/* ── حوار الإدخال اليدوي للباركود ── */}
      {manualInputOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 p-5 w-full max-w-sm shadow-xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Barcode className="size-5 text-primary" />
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white">
                  إدخال الباركود يدوياً
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setManualInputOpen(false)}
                className="size-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="size-4" />
              </button>
            </div>

            <form onSubmit={handleManualSubmit} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="manual-barcode-input"
                  className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5"
                >
                  رقم الباركود المطبوع على الملصق:
                </label>
                <input
                  id="manual-barcode-input"
                  dir="ltr"
                  type="text"
                  inputMode="text"
                  autoFocus
                  value={manualInputValue}
                  onChange={(e) => setManualInputValue(e.target.value)}
                  placeholder="مثال: 6291041500213"
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm font-mono placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!manualInputValue.trim()}
                  className="flex-1 h-11 rounded-xl bg-primary hover:bg-primary/95 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-xs"
                >
                  <Search className="size-3.5" />
                  <span>استعلام السعر</span>
                </button>
                <button
                  type="button"
                  onClick={() => setManualInputOpen(false)}
                  className="h-11 px-4 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 text-xs font-bold hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── ماسح الكاميرا فائق السرعة عبر CameraScanner ── */}
      <CameraScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetect={handleDetectBarcode}
        onManualDetect={handleDetectBarcode}
      />
    </div>
  );
}
