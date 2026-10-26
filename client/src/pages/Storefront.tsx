import { StorefrontCartPanel } from "@/components/storefront/StorefrontCartPanel";
import { StorefrontCatalogSurface } from "@/components/storefront/StorefrontCatalogSurface";
import { StorefrontCheckoutPanel } from "@/components/storefront/StorefrontCheckoutPanel";
import { StorefrontConfirmationPanel } from "@/components/storefront/StorefrontConfirmationPanel";
import { StorefrontFooter } from "@/components/storefront/StorefrontFooter";
import { StorefrontHeader } from "@/components/storefront/StorefrontHeader";
import { type BannerItem } from "@/components/storefront/StorefrontInlineStrip";
import { StorefrontLabelPanel } from "@/components/storefront/StorefrontLabelPanel";
import { storefrontVariantMedia } from "@/components/storefront/StorefrontMedia";
import { StorefrontProductDialog } from "@/components/storefront/StorefrontProductDialog";
import { type StorefrontProductForCartAction,recommendationNeedsSelection,storefrontProductCanBeOrdered } from "@/components/storefront/StorefrontRecommendations";
import { StorefrontTrackingPanel } from "@/components/storefront/StorefrontTrackingPanel";
import { type CartLine,type StorefrontCartSelection,addStorefrontCartLine,addStorefrontCartLines,applyStorefrontProductQuantityDelta,money,reconcileStorefrontCartPricing,reconcileStorefrontCartQuote,recordStorefrontCartChange,setStorefrontCartQuantity,summarizeStorefrontProductCartQuantities } from "@/components/storefront/storefrontCartMath";
import { type AvailabilityFilter,type CatalogSort,type Panel,type PriceFilter,type ShareFeedbackTone,collectStorefrontFailures,hasStorefrontAnalyticsConsent,shouldAutoLoadStorefrontNextPage } from "@/components/storefront/storefrontCatalogModel";
import { type StorefrontCustomization,type StorefrontCustomizationField,buildStorefrontCustomizationPayload,customizationCartKey,getStorefrontCustomizationConfig } from "@/components/storefront/storefrontCustomizationModel";
import { type CustomizationStudioUploadState,isCustomizationUploadBlockingAddToCart } from "@/components/storefront/storefrontCustomizationUpload";
import { type CheckoutFieldErrors,type CheckoutForm,DEFAULT_FORM,STOREFRONT_PERSIST_REQUEST_EVENT,type StorefrontCheckoutAttempt,loadCart,loadCheckoutAttempt,loadForm,loadStorefrontWishlist,saveCart,saveCheckoutAttempt,saveStorefrontSnapshot,storefrontCheckoutFingerprint,validateStorefrontCheckout } from "@/components/storefront/storefrontPersistence";
import { storefrontSharingActions } from "@/components/storefront/storefrontSharing";
import { storefrontCatalogProductScope } from "@/components/storefront/storefrontCatalogModel";
import { storefrontShippingThreshold } from "@/lib/storefrontShipping";
export { BundleMedia,clampStorefrontZoomPoint,storefrontMediaUrls,storefrontVariantMedia } from "@/components/storefront/StorefrontMedia";
export { recommendationActionLabel,recommendationNeedsSelection,storefrontProductCanBeOrdered } from "@/components/storefront/StorefrontRecommendations";
export { addStorefrontCartLine,addStorefrontCartLines,applyStorefrontProductQuantityDelta,reconcileStorefrontCartPricing,reconcileStorefrontCartQuote,recordStorefrontCartChange,resolveStorefrontProductQuantityDelta,setStorefrontCartQuantity,summarizeStorefrontProductCartQuantities,type CartLine,type StorefrontCartProduct,type StorefrontCartSelection,type StorefrontPricingSnapshot,type StorefrontProductCartSummary,type StorefrontProductQuantityDeltaAction } from "@/components/storefront/storefrontCartMath";
export { collectStorefrontFailures,shouldAutoLoadStorefrontNextPage,storefrontCategoryCount,type AvailabilityFilter,type StorefrontSource } from "@/components/storefront/storefrontCatalogModel";
export { buildStorefrontCustomizationPayload,createStorefrontCatalogSeedBucket,getStorefrontCustomizationConfig,storefrontTurnstileSubmissionReady,summarizeStorefrontCustomization,type StorefrontCustomization,type StorefrontCustomizationConfig,type StorefrontCustomizationField,type StorefrontCustomizationKind,type StorefrontCustomizationTemplate } from "@/components/storefront/storefrontCustomizationModel";
export { loadCart,loadCheckoutAttempt,saveCart,saveCheckoutAttempt,saveForm,saveStorefrontSnapshot,storefrontCheckoutFingerprint,validateStorefrontCheckout,type CheckoutFieldErrors,type CheckoutForm,type StorefrontCheckoutAttempt } from "@/components/storefront/storefrontPersistence";
/**
 * /store — واجهة المتجر التسويقي للزبون (B2C) على الجوال.
 *
 * صفحة **علنية** بملء الشاشة (بلا AppLayout وبلا جلسة دخول) — نقطة دخول التطبيق للزبون.
 * تصفّح كتالوجك الحقيقي (storefront.*، بيانات آمنة) + سلة + **الدفع عند الاستلام**.
 * زرّ «دخول الفريق» منفصلٌ في الترويسة يفتح دخول الموظف/المندوب بعيداً عن المتجر.
 *
 * نظام عرض تجاري مستقل للمتجر: تنقل واضح، اكتشاف بالفئات، عروض مختارة، كتالوج قابل للتصفية، وسلة ودفع عند الاستلام.
 * الأولوية للوضوح والمقارنة وسرعة الوصول إلى قرار الشراء، مع الحفاظ على منطق البيانات الحقيقي في النظام.
 */
import { CategoryChipStrip } from "@/components/storefront/CategoryChipStrip";
import { ConsentChoice,ConsentProvider } from "@/components/storefront/ConsentChoice";
import { StoreTrustAndHelp } from "@/components/storefront/StoreTrustAndHelp";
import { type RowProduct } from "@/components/storefront/StorefrontCuratedRows";
import { StorefrontFloatingCart } from "@/components/storefront/StorefrontFloatingCart";
import { StorefrontStickyFilter } from "@/components/storefront/StorefrontStickyFilter";
import { type ThematicCollectionCard } from "@/components/storefront/StorefrontThematicStrip";
import { useOrderTrackingRefresh } from "@/hooks/useOrderTrackingRefresh";
import { useStorefrontCoupon } from "@/hooks/useStorefrontCoupon";
import { useStorefrontUrlSync } from "@/hooks/useStorefrontUrlSync";
import { formatQuantity } from "@/lib/money";
import { type RouterOutputs,trpc } from "@/lib/trpc";
import { deliveryFeeFor } from "@shared/governorates";
import { getStorefrontSearchSuggestions } from "@shared/storefrontSearchNormalize";
import {
MessageCircle
} from "lucide-react";
import React,{ useEffect,useMemo,useRef,useState } from "react";
import { DEFAULT_STOREFRONT_CUSTOMIZATION_MAX_LENGTH,storefrontVisibleCustomizationFieldKeys } from "./store/storefrontCustomization";

export { formatStorefrontReservationDeadline } from "@/components/storefront/storefrontCatalogModel";
export type TrackData = NonNullable<RouterOutputs["storefront"]["trackOrderByToken"]>;

import { STORE_NAME } from "@/components/storefront/storefrontCatalogModel";

// حفظ السلة + بيانات التوصيل محلياً (مراجعة عدائية ١٢/٧): كان تحديث الصفحة/العودة للتطبيق يفرّغ
// السلة والنموذج فيهجر الزبون الطلب. نُبقيهما في localStorage فيستأنف الزبون من حيث توقّف.

import { type GuestTrackingOrder,loadGuestTrackingOrders,rememberGuestTrackingOrder } from "@/lib/storefrontGuestTracking";

/** اختيارٌ واحد من نافذة المنتج. تبقى الأسعار معلومات عرض فقط؛ الخادم يعيد التسعير عند إنشاء الطلب. */

/**
 * إضافة عدة ألوان/متغيرات بضغطة واحدة مع دمج كل وحدة بيع في سطر سلتها القائم.
 * لا نثق بالكمية أو السعر هنا عند الدفع: createOrder يعيد التحقق من المخزون والتسعير خادمياً.
 */

// موحَّد مع الخادم عبر [`@shared/storefrontSearchNormalize`](../../../shared/storefrontSearchNormalize.ts).
// كان تعريفاً محلياً منسوخاً؛ فرضُ الاستيراد يمنع انحرافاً صامتاً بين تصفية العميل وLIKE الخادميّ
// (كان يجعل الاقتراح يظهر لحظياً ثمّ يختفي حين يستبدل الخادم الصفحات — Codex P2 على #904).

/** يجمع صور العرض الحقيقية ويمنع تكرارها مع سقف يحافظ على خفة البطاقة. */

/** يختار معرض البديل النشط، ويرجع لمعرض المنتج العام إن لم يوجد البديل في العقد. */

/** تقليب صور البطاقة عند المؤشر/اللمس — يتوقف خارج البطاقة ويحترم reduced-motion. */

/** معرض تفاصيل المنتج مع تقليب تلقائي، عدسة تكبير تتبع المؤشر، وفتح كامل على الهاتف. */

/**
 * يعرض صور مكوّنات البكج بالمرجع من دون إنشاء نسخ جديدة منها.
 * الصورة التسويقية الخاصة بالبكج تبقى صاحبة الأولوية لأن الخادم لا يعيد
 * bundleImageUrls عند وجودها.
 */

export { CategoryChipStrip };

/** بنر إعلانيّ ديناميكيّ: كاروسيل يتبدّل تلقائياً كل ٥ث (crossfade آمنٌ لـRTL) + نقاط تنقّل +
 *  ارتفاعٌ متجاوب (auto-scale). يُشتقّ من بنرات لوحة hPanel؛ بنرٌ واحد ⇒ يُعرَض ثابتاً بلا نقاط. */

/**
 * فاصل تسويقي عرضي داخل شبكة المنتجات (placement=INLINE) — يقطع سيل المنتجات كل عشرة أصناف
 * بشريط ترويجي (نمط in-feed banner العالمي: أمازون/علي إكسبرس). `col-span-full` يمتدّ على كامل
 * أعمدة الشبكة أياً كان عددها المتجاوب.
 */

/**
 * يبقي فشل كل مصدرٍ علنيّ حالةً مستقلة وصريحة. لا يجوز تحويل خطأ API إلى [] ثم وصفه
 * للزبون بأنه «لا توجد فئات/عروض/منتجات»؛ الفراغ التجاري الصحيح لا يأتي إلا بعد نجاح الطلب.
 */

// اقتراحات البحث موحدة مع الخادم عبر `@shared/storefrontSearchNormalize`:
// تطابق متعدد الكلمات (Tokens) بأي ترتيب مع تطبيع الأرقام والحروف والبحث الجزئي وترتيب الملاءمة.
export { getStorefrontSearchSuggestions };

// نغمةُ شريط المشاركة تُرافق الرسالة ولا تُثبَّت: القناةُ واحدةٌ تحمل النجاح والفشل معاً
// (تحميلُ سلةٍ مشتركة · نسخُ رابط · تعذّرُ المشاركة · تعذّرُ إنشاء الرابط)، فصندوقٌ أخضر ثابت
// كان يؤكّد على «تعذّرت المشاركة» نجاحاً لم يقع — وهو نفسه سببُ إبقائها خارج توحيد الألوان.

function StorefrontContent() {
  const [rawSearch, setRawSearch] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [selectedThematicCollection, setSelectedThematicCollection] = useState<ThematicCollectionCard | null>(null);
  // البدء بالمتوفر يحمي نية الشراء: لا نُغرق العميل ببطاقات لا يمكن إضافتها للسلة.
  const [availability, setAvailability] = useState<AvailabilityFilter>("IN_STOCK");
  const [priceFilter, setPriceFilter] = useState<PriceFilter>("ALL");
  const [brand, setBrand] = useState("");
  const [sort, setSort] = useState<CatalogSort>("RECOMMENDED");
  const [catalogSeed, setCatalogSeed] = useState(() => `sf-${Math.floor(Date.now() / (15 * 60 * 1000))}`);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [recentlyAddedProductId, setRecentlyAddedProductId] = useState<number | null>(null);
  const [heartPulseTarget, setHeartPulseTarget] = useState<string | null>(null);
  const [heartPulseNonce, setHeartPulseNonce] = useState(0);
  const [sharePulseTarget, setSharePulseTarget] = useState<string | null>(null);
  const [sharePulseNonce, setSharePulseNonce] = useState(0);
  const [selectedStoreUnitId, setSelectedStoreUnitId] = useState<number | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  // اختيار متعدد للمتغيرات في ورقة المنتج. المفتاح هو وحدة البيع، لا معرّف المتغير،
  // كي لا تختلط وحدات مختلفة للون نفسه داخل السلة أو عند التسعير الخادمي.
  const [variantQuantities, setVariantQuantities] = useState<Map<number, number>>(new Map());
  const [customizationDraft, setCustomizationDraft] = useState<StorefrontCustomization>({ templateId: 0, kind: "PRINT" });
  const [customizationUploadState, setCustomizationUploadState] = useState<CustomizationStudioUploadState>("idle");
  const setCustomizationAssets = (assets: { logoAssetKey?: string; previewAssetKey?: string }) => setCustomizationDraft((prev) => ({ ...prev, logoAssetKey: assets.logoAssetKey || undefined, previewAssetKey: assets.previewAssetKey || undefined }));
  const [panel, setPanel] = useState<Panel>(null);
  const [wishlistIds, setWishlistIds] = useState<Set<number>>(loadStorefrontWishlist);
  const [showWishlist, setShowWishlist] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<{ text: string; tone: ShareFeedbackTone } | null>(null);
  const [cart, setCart] = useState<Map<string, CartLine>>(loadCart);
  const [cartStatus, setCartStatus] = useState("");
  const cartRecommendationProductIds = useMemo(
    () => Array.from(cart.values()).map((line) => line.productId).slice(0, 24),
    [cart],
  );

  const [form, setForm] = useState<CheckoutForm>(loadForm);
  const [checkoutErrors, setCheckoutErrors] = useState<CheckoutFieldErrors>({});
  const productDialogCloseRef = useRef<HTMLButtonElement | null>(null);
  const productDialogTriggerRef = useRef<HTMLElement | null>(null);
  const [productReviewOpenRequest, setProductReviewOpenRequest] = useState<{ open: boolean; orderNumber?: string | null }>({ open: false });
  function openProduct(productId: number, options?: { openReview?: boolean; orderNumber?: string | null }) {
    const activeElement = typeof document === "undefined" ? null : document.activeElement;
    productDialogTriggerRef.current = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null;
    setProductReviewOpenRequest({ open: options?.openReview ?? false, orderNumber: options?.orderNumber ?? null });
    setSelectedId(productId);
  }
  const cartRef = useRef(cart);
  const formRef = useRef(form);
  cartRef.current = cart;
  formRef.current = form;
  const [checkoutAttempt, setCheckoutAttempt] = useState<StorefrontCheckoutAttempt | null>(loadCheckoutAttempt);
  const checkoutAttemptRef = useRef(checkoutAttempt);
  const orderInFlightRef = useRef(false);
  const acceptedQuoteRef = useRef<{ fingerprint: string; total: string } | null>(null);
  checkoutAttemptRef.current = checkoutAttempt;
  const [checkoutSafetyError, setCheckoutSafetyError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [confirmation, setConfirmation] = useState<{
    orderNumber: string;
    total: string;
    reservationExpiresAt: Date | string;
  } | null>(null);
  const {
    couponDraft,
    setCouponDraft,
    appliedCouponCode,
    setAppliedCouponCode,
    couponFeedback,
    setCouponFeedback,
    applyCoupon,
    removeCoupon,
    clearCouponOnSuccess,
    persistValidCoupon,
    invalidateCoupon,
  } = useStorefrontCoupon({
    onQuoteInvalidate: () => {
      acceptedQuoteRef.current = null;
      setCheckoutSafetyError(null);
    },
  });

  const viewedProductIds = useRef(new Set<number>());
  const catalogLoadMoreRef = useRef<HTMLDivElement | null>(null);

  // تتبّع الضيف بملكيةٍ opaque قصيرة العمر؛ لا رقم هاتف ولا بيانات عميل في الطلب أو التخزين.
  const utils = trpc.useUtils();
  const trackOrderByToken = trpc.storefront.trackOrderByToken.useMutation();
  const [trustedTrackingOrders, setTrustedTrackingOrders] = useState<GuestTrackingOrder[]>(loadGuestTrackingOrders);
  const [trackToken, setTrackToken] = useState("");
  const [trackResult, setTrackResult] = useState<TrackData | null>(null);
  const [trackResultToken, setTrackResultToken] = useState<string | null>(null);
  const trackRequestVersion = useRef(0);
  const [trackState, setTrackState] = useState<"idle" | "loading" | "notfound" | "error">("idle");
  const [trackError, setTrackError] = useState<string | null>(null);
  const labelParams = useMemo(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    const orderNumber = q.get("order");
    const token = q.get("token");
    return orderNumber && token ? { orderNumber, token } : null;
  }, []);
  const openTrack = (orderNumber = "") => {
    trackRequestVersion.current++;
    const saved = loadGuestTrackingOrders();
    setTrustedTrackingOrders(saved);
    setTrackToken(saved.find((order) => order.orderNumber === orderNumber)?.trackingToken ?? "");
    setTrackResult(null);
    setTrackResultToken(null);
    setTrackState("idle");
    setTrackError(null);
    setPanel("track");
  };
  const doTrack = async (savedToken?: string) => {
    const requestVersion = ++trackRequestVersion.current;
    const trackingToken = (savedToken ?? trackToken).trim();
    setTrackToken(trackingToken);
    setTrackResult(null);
    setTrackResultToken(null);
    setTrackState("idle");
    if (trackingToken.length < 60 || trackingToken.length > 160) {
      setTrackError("ألصق رمز التتبّع الكامل الصادر بعد إنشاء الطلب.");
      window.requestAnimationFrame(() => document.getElementById("storefront-track-token")?.focus());
      return;
    }
    setTrackError(null);
    setTrackState("loading");
    try {
      const result = await trackOrderByToken.mutateAsync({ trackingToken });
      if (requestVersion !== trackRequestVersion.current) return;
      setTrackResult(result);
      setTrackResultToken(trackingToken);
      setTrackState("idle");
    } catch (error) {
      if (requestVersion !== trackRequestVersion.current) return;
      const code = typeof error === "object" && error && "data" in error
        ? (error as { data?: { code?: string } }).data?.code
        : undefined;
      setTrackState(code === "NOT_FOUND" ? "notfound" : "error");
    }
  };
  useOrderTrackingRefresh({
    enabled: panel === "track" && trackToken.trim() === trackResultToken,
    trackingToken: trackResultToken,
    result: trackResult,
    fetchLatest: async trackingToken => {
      const requestVersion = trackRequestVersion.current;
      try {
        const result = await trackOrderByToken.mutateAsync({ trackingToken });
        if (!result) throw Object.assign(new Error("Tracking unavailable"), { code: "NOT_FOUND" });
        if (requestVersion !== trackRequestVersion.current) throw new Error("Tracking request superseded");
        return result;
      } catch (error) {
        if (requestVersion !== trackRequestVersion.current) throw new Error("Tracking request superseded");
        throw error;
      }
    },
    onResult: setTrackResult,
    onUnavailable: () => {
      trackRequestVersion.current++;
      setTrackResult(null);
      setTrackResultToken(null);
      setTrackState("idle");
      setTrackError("لم يعد رمز التتبع متاحا. أعد إدخال الرمز الصحيح أو تواصل مع المتجر للحصول على رابط جديد.");
    },
  });

  useEffect(() => {
    const t = setTimeout(() => setSearch(rawSearch.trim()), 220);
    return () => clearTimeout(t);
  }, [rawSearch]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${STORE_NAME} | التسوق والتوصيل في العراق`;
    return () => { document.title = previousTitle; };
  }, []);

  // ثيم تسويقيّ فاتح دائماً للمتجر (ملاحظة المالك ١٢/٧): الوضع الداكن يُتحكَّم به عبر class="dark" على
  // <html>؛ لكن واجهة الزبون يجب أن تبقى مضيئةً جذّابة تُشجّع الشراء بصرف النظر عن إعداد جهازه. نُزيل
  // الوضع الداكن ما دام المتجر معروضاً، ونُعيده عند المغادرة (لئلّا نؤثّر على واجهة الموظّف/الدخول).
  useEffect(() => {
    const html = document.documentElement;
    const hadDark = html.classList.contains("dark");
    html.classList.remove("dark");
    return () => {
      if (hadDark) html.classList.add("dark");
    };
  }, []);

  // استمرار السلة + بيانات التوصيل عبر تحديث الصفحة/إغلاق التطبيق (localStorage). طلب التحديث
  // الآمن يستدعي الحافظ المتزامن أدناه ويأخذ نتيجة صريحة؛ امتلاء التخزين لا يعود فشلاً صامتاً.
  useEffect(() => {
    saveStorefrontSnapshot(cart, form, localStorage, checkoutAttempt);
  }, [cart, form, checkoutAttempt]);
  useEffect(() => {
    const persist = (event: Event) => {
      const detail = (event as CustomEvent<{ report: (saved: boolean, state?: { inFlight: boolean }) => void }>).detail;
      detail?.report(
        saveStorefrontSnapshot(cartRef.current, formRef.current, localStorage, checkoutAttemptRef.current),
        { inFlight: orderInFlightRef.current },
      );
    };
    window.addEventListener(STOREFRONT_PERSIST_REQUEST_EVENT, persist);
    return () => window.removeEventListener(STOREFRONT_PERSIST_REQUEST_EVENT, persist);
  }, []);

  const categoriesQ = trpc.storefront.categories.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const offersQ = trpc.storefront.offers.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const bannersQ = trpc.storefront.banners.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  const settingsQ = trpc.storefront.settings.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  // يطبّق الخادم مرشح التوفر قبل حدّ الصفحة. useInfiniteQuery يمرّر nextCursor فقط عند
  // «تحميل المزيد»، فتصل كل المنتجات المنشورة بلا سقف 120 صامت ولا تكرار بطاقات.
  const searchProductIds = useMemo(() => {
    return storefrontCatalogProductScope(showWishlist, wishlistIds, selectedThematicCollection?.productIds);
  }, [showWishlist, wishlistIds, selectedThematicCollection]);
  const catalogInput = {
    categoryId,
    productIds: searchProductIds,
    brand: brand || undefined,
    priceFilter,
    sort,
    search: search || undefined,
    limit: 48,
    availability,
    seed: sort === "RECOMMENDED" && !search ? catalogSeed : undefined,
  } as const;
  const catalogQ = trpc.storefront.catalog.useInfiniteQuery(
    catalogInput,
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const detailQ = trpc.storefront.product.useQuery({ productId: selectedId ?? 0 }, { enabled: selectedId != null });
  useStorefrontUrlSync({ selectedId, setSelectedId, selectedProductTitle: detailQ.data?.productName, categoryId, setCategoryId });
  const labelQ = trpc.storefront.labelSummary.useQuery(labelParams ?? { orderNumber: "-", token: "-" }, { enabled: labelParams != null, retry: false });
  const relatedQ = trpc.storefront.related.useQuery({ productId: selectedId ?? 0 }, { enabled: selectedId != null });
  const recommendationClickM = trpc.storefront.trackRecommendationClick.useMutation();
  const createCartShareM = trpc.storefront.createCartShare.useMutation();
  const cartRecommendationsQ = trpc.storefront.cartRecommendations.useQuery(
    { productIds: cartRecommendationProductIds },
    {
      enabled: panel === "cart" && cartRecommendationProductIds.length > 0,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const trackRecommendationClick = (recommendedProductId: number) => {
    if (selectedId == null || !hasStorefrontAnalyticsConsent()) return;
    recommendationClickM.mutate({ sourceProductId: selectedId, recommendedProductId });
  };
  const storefrontQuoteLines = useMemo(
    () => Array.from(cart.values()).map((line) => ({ productUnitId: line.productUnitId, quantity: line.qty,
      customization: buildStorefrontCustomizationPayload(line.customization) })),
    [cart],
  );
  const storefrontQuoteInput = useMemo(() => ({
    governorate: form.governorate,
    lines: storefrontQuoteLines,
  }), [form.governorate, storefrontQuoteLines]);
  const privateQuoteRequired = Boolean(appliedCouponCode) || storefrontQuoteLines.some((line) => line.customization != null);
  const publicQuoteQ = trpc.storefront.quoteOrder.useQuery(storefrontQuoteInput, {
    enabled: panel === "checkout" && cart.size > 0 && !privateQuoteRequired,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const privateQuoteM = trpc.storefront.quoteOrderPrivate.useMutation();
  const privateQuoteInput = useMemo(() => privateQuoteRequired ? ({
    ...(appliedCouponCode ? { couponCode: appliedCouponCode } : {}),
    governorate: form.governorate,
    lines: storefrontQuoteLines,
  }) : null, [appliedCouponCode, form.governorate, privateQuoteRequired, storefrontQuoteLines]);
  useEffect(() => {
    if (panel !== "checkout" || cart.size === 0 || !privateQuoteInput) {
      privateQuoteM.reset();
      return;
    }
    privateQuoteM.reset();
    privateQuoteM.mutate(privateQuoteInput);
  // mutation functions are stable; request identity is the intentional trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.size, panel, privateQuoteInput]);

  useEffect(() => {
    if (!appliedCouponCode) return;
    if (privateQuoteM.isError) {
      invalidateCoupon();
    } else if (privateQuoteM.data) {
      persistValidCoupon(appliedCouponCode);
    }
  }, [appliedCouponCode, privateQuoteM.data, privateQuoteM.isError, persistValidCoupon, invalidateCoupon]);

  const quoteQ = {
    data: privateQuoteRequired ? privateQuoteM.data : publicQuoteQ.data,
    isFetching: privateQuoteRequired ? privateQuoteM.isPending : publicQuoteQ.isFetching,
    isError: privateQuoteRequired ? privateQuoteM.isError : publicQuoteQ.isError,
    error: privateQuoteRequired ? privateQuoteM.error : publicQuoteQ.error,
  };
  const trackConversion = trpc.storefront.trackConversion.useMutation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("cartToken")?.trim();
    if (!token || !/^[A-Za-z0-9_-]{20,32}$/.test(token)) return;
    let cancelled = false;
    void utils.storefront.getCartShare.fetch({ token }).then((shared) => {
      if (cancelled) return;
      const incoming = new Map<string, CartLine>();
      for (const item of shared.items) {
        const line: CartLine = {
          cartKey: customizationCartKey(item.productUnitId),
          productUnitId: item.productUnitId,
          productId: item.productId,
          name: item.name,
          price: Number(item.price).toFixed(2),
          imageUrl: item.imageUrl,
          unitName: item.unitName,
          variantLabel: item.variantLabel,
          qty: Math.min(Math.max(Math.floor(item.quantity), 1), 999),
        };
        incoming.set(line.cartKey, line);
      }
      if (incoming.size > 0) {
        setCart((current) => {
          const next = new Map(current);
          incoming.forEach((line) => next.set(line.cartKey, line));
          saveCart(next);
          return next;
        });
        setShareFeedback(shared.skippedCount > 0
          ? { text: `تم تحميل ${incoming.size} من المنتجات؛ أزيل ${shared.skippedCount} لم يعد متاحاً. راجع الأسعار قبل التأكيد`, tone: "warn" }
          : { text: "تم تحميل السلة المشتركة؛ راجع الأسعار قبل التأكيد", tone: "ok" });
      }
    }).catch(() => {
      if (!cancelled) setShareFeedback({ text: "تعذّر فتح رابط السلة أو انتهت صلاحيته؛ يمكنك متابعة التصفح بشكل طبيعي", tone: "err" });
    });
    return () => { cancelled = true; };
  }, [utils]);

  // كل فتح متعمد لتفاصيل منتج = مشاهدة؛ لا نرسل اسم المنتج أو هويّة/جلسة الزائر.
  useEffect(() => {
    if (selectedId != null && !viewedProductIds.current.has(selectedId)) {
      viewedProductIds.current.add(selectedId);
      if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "PRODUCT_VIEW" });
    }
  // useMutation يعيد مرجعاً مستقراً؛ ربط الحدث بالمُنتج فقط يمنع إعادة عدّه عند كل render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const createOrder = trpc.storefront.createOrder.useMutation({
    onMutate: () => {
      orderInFlightRef.current = true;
      setCheckoutSafetyError(null);
    },
    onSuccess: (res) => {
      orderInFlightRef.current = false;
      setTurnstileToken(null);
      checkoutAttemptRef.current = null;
      acceptedQuoteRef.current = null;
      setCheckoutAttempt(null);
      saveCheckoutAttempt(null);
      setConfirmation({
        orderNumber: res.orderNumber,
        total: res.total,
        reservationExpiresAt: res.reservationExpiresAt,
      });
      if (res.guestTrackingToken && res.guestTrackingExpiresAt) {
        const expiresAt = res.guestTrackingExpiresAt instanceof Date
          ? res.guestTrackingExpiresAt.toISOString()
          : new Date(res.guestTrackingExpiresAt).toISOString();
        setTrustedTrackingOrders(rememberGuestTrackingOrder({
          orderNumber: res.orderNumber,
          trackingToken: res.guestTrackingToken,
          expiresAt,
        }));
      }
      setCart(new Map());
      clearCouponOnSuccess();
      // امسح بيانات التوصيل (اسم/هاتف/عنوان) من الحالة و localStorage بعد نجاح الطلب (مراجعة عدائية
      // ١٢/٧): المتجر علنيّ بلا جلسة ⇒ إبقاؤها يسرّبها للزبون التالي على جهازٍ مشترك/كشك. الاستعادة
      // عبر التحديث تخصّ طلباً قيد الإنشاء فقط، لا بعد إتمامه.
      setForm({ ...DEFAULT_FORM });
      setPanel("confirmation");
    },
    onError: async (error) => {
      orderInFlightRef.current = false;
      // token أحادي الاستعمال: أي رد خطأ/ضائع يحتاج challenge جديداً. إن كان الطلب قد
      // التزم فعلاً فـowned replay الخادمي يسبق استهلاك token الجديد.
      setTurnstileToken(null);
      setTurnstileResetKey((key) => key + 1);
      if (error.data?.code === "CONFLICT") {
        const failedAttempt = checkoutAttemptRef.current;
        checkoutAttemptRef.current = null;
        acceptedQuoteRef.current = null;
        setCheckoutAttempt(null);
        saveCheckoutAttempt(null);
        await Promise.all([
          utils.storefront.catalog.invalidate(),
          utils.storefront.offers.invalidate(),
          utils.storefront.settings.invalidate(),
          utils.storefront.product.invalidate(),
          utils.storefront.quoteOrder.invalidate(),
        ]);
        try {
          const currentQuoteInput = {
            governorate: formRef.current.governorate,
            lines: Array.from(cartRef.current.values()).map((line) => ({
              productUnitId: line.productUnitId,
              quantity: line.qty,
              customization: buildStorefrontCustomizationPayload(line.customization),
            })),
          };
          const currentRequiresPrivateQuote = Boolean(appliedCouponCode) || currentQuoteInput.lines.some((line) => line.customization != null);
          const quoted = currentRequiresPrivateQuote
            ? await privateQuoteM.mutateAsync({ ...currentQuoteInput, ...(appliedCouponCode ? { couponCode: appliedCouponCode } : {}) })
            : await utils.storefront.quoteOrder.fetch(currentQuoteInput);
          const refreshedQuote = reconcileStorefrontCartQuote(cartRef.current, quoted.lines);
          const totalChanged = failedAttempt == null ||
            Number(quoted.total).toFixed(2) !== Number(failedAttempt.expectedGrandTotal).toFixed(2);
          if (refreshedQuote.unresolved === 0 && (refreshedQuote.priceChanged > 0 || totalChanged)) {
            cartRef.current = refreshedQuote.cart;
            setCart(refreshedQuote.cart);
            acceptedQuoteRef.current = {
              fingerprint: storefrontCheckoutFingerprint(refreshedQuote.cart, formRef.current, appliedCouponCode),
              total: quoted.total,
            };
            setCheckoutSafetyError(
              refreshedQuote.priceChanged > 0
                ? `تحديث سعر ${refreshedQuote.priceChanged} من أصناف السلة. راجع الإجمالي الجديد ثم اضغط «تأكيد الطلب» للموافقة عليه.`
                : "تغيّر إجمالي الطلب أو التوصيل. راجع الإجمالي الجديد ثم اضغط «تأكيد الطلب» للموافقة عليه.",
            );
            return;
          }
        } catch {
          // إذا لم يعد الصنف منشوراً، يسقط المسار إلى reconciliation التفاصيل أدناه لحذفه صراحةً.
        }
        const productIds = Array.from(new Set(Array.from(cartRef.current.values()).map((line) => line.productId)));
        const latestEntries = await Promise.all(productIds.map(async (productId) => {
          try {
            return [productId, await utils.storefront.product.fetch({ productId })] as const;
          } catch {
            return [productId, undefined] as const;
          }
        }));
        const refreshed = reconcileStorefrontCartPricing(
          cartRef.current,
          new Map(latestEntries),
        );
        if (refreshed.priceChanged > 0 || refreshed.unavailable > 0) {
          cartRef.current = refreshed.cart;
          setCart(refreshed.cart);
          const changes = [
            refreshed.priceChanged > 0 ? `تحديث سعر ${refreshed.priceChanged} من أصناف السلة` : null,
            refreshed.unavailable > 0 ? `إزالة ${refreshed.unavailable} لم يعد متاحاً` : null,
          ].filter(Boolean).join("، ");
          setCheckoutSafetyError(`${changes}. راجع الإجمالي الجديد ثم اضغط «تأكيد الطلب» للموافقة عليه.`);
        } else if (refreshed.unresolved > 0) {
          setCheckoutSafetyError("تغيّرت بيانات الطلب وتعذّر جلب بعض الأسعار الجديدة. تحقق من الاتصال ثم أعد المحاولة.");
        } else {
          setCheckoutSafetyError(error.message);
        }
      }
    },
    onSettled: () => {
      orderInFlightRef.current = false;
    },
  });

  const detailVariant = useMemo(() => {
    const variants = detailQ.data?.variants ?? [];
    return variants.find((v) => v.variantId === selectedVariantId) ?? variants.find((v) => v.inStock) ?? variants[0] ?? null;
  }, [detailQ.data, selectedVariantId]);
  const detailUnit = useMemo(() => {
    const product = detailQ.data;
    if (!product) return null;
    const options = detailVariant?.units ?? product.storeUnits ?? [];
    return options.find((u) => u.productUnitId === selectedStoreUnitId) ?? options[0] ?? {
      productUnitId: product.productUnitId,
      unitName: product.unitName,
      conversionFactor: "1",
      price: product.price,
      salePrice: product.salePrice,
      promotionName: product.promotionName,
      inStock: product.inStock,
      stockLeft: product.stockLeft,
    };
  }, [detailQ.data, detailVariant, selectedStoreUnitId]);
  const detailMedia = useMemo(
    () => detailQ.data ? storefrontVariantMedia(detailQ.data, detailVariant?.variantId) : { urls: undefined, fallbackUrl: null },
    [detailQ.data, detailVariant],
  );
  const customizationPreviewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "customization";
  const previewCustomizationTemplate = customizationPreviewMode && detailQ.data?.category === "المطبوعات التجارية"
    ? {
        id: 0,
        kind: "PRINT" as const,
        title: "خصّص طلبك قبل الإضافة",
        description: "وضع معاينة تطويري فقط — القالب الحقيقي يأتي من الخادم بعد تطبيق الهجرة.",
        fields: [
          { id: 0, fieldKey: "service", label: "نوع التنفيذ", fieldType: "SELECT" as const, isRequired: true, sortOrder: 10, maxLength: null, priceDelta: "0", dependency: null, options: [{ value: "text", label: "اسم أو عبارة", priceDelta: "0" }, { value: "file", label: "صورة أو تصميم", priceDelta: "0" }, { value: "full", label: "طباعة كاملة", priceDelta: "0" }] },
          { id: 1, fieldKey: "packaging", label: "التغليف", fieldType: "SELECT" as const, isRequired: false, sortOrder: 20, maxLength: null, priceDelta: "0", dependency: null, options: [{ value: "standard", label: "تغليف عادي", priceDelta: "0" }, { value: "gift", label: "تغليف هدية", priceDelta: "0" }] },
          { id: 2, fieldKey: "message", label: "رسالة أو تفاصيل إضافية", fieldType: "TEXTAREA" as const, isRequired: false, sortOrder: 30, maxLength: 300, priceDelta: "0", dependency: { fieldKey: "service", operator: "equals" as const, value: ["text", "full"] }, options: [] },
          { id: 3, fieldKey: "designFile", label: "مرجع ملف التصميم", fieldType: "FILE" as const, isRequired: true, sortOrder: 40, maxLength: null, priceDelta: "0", dependency: { fieldKey: "service", operator: "equals" as const, value: ["file", "full"] }, options: [] },
        ],
      }
    : null;
  const customizationConfig = useMemo(
    () => detailQ.data
      ? getStorefrontCustomizationConfig(
          detailQ.data.isCustomizable === true || previewCustomizationTemplate != null,
          detailQ.data.customizationKind ?? (previewCustomizationTemplate ? "PRINT" : null),
          detailQ.data.customizationTemplate ?? previewCustomizationTemplate,
        )
      : null,
    [detailQ.data, previewCustomizationTemplate],
  );
  const customizationValues = customizationDraft.values ?? {};
  const visibleCustomizationFields = useMemo(() => {
    const fields = customizationConfig?.fields ?? [];
    const visibleKeys = storefrontVisibleCustomizationFieldKeys(fields, customizationValues);
    return fields.filter((field) => visibleKeys.has(field.fieldKey));
  }, [customizationConfig, customizationValues]);
  const customizationValidation = useMemo(() => {
    if (!customizationConfig) return null;
    for (const field of visibleCustomizationFields) {
      const value = customizationValues[field.fieldKey]?.trim() ?? "";
      if (field.isRequired && !value) return `أكمل الحقل «${field.label}» قبل الإضافة`;
      if (["SELECT", "SWATCH"].includes(field.fieldType) && value && !field.options.some((option) => option.value === value)) {
        return `اختر قيمة صحيحة للحقل «${field.label}»`;
      }
      if (value.length > (field.maxLength ?? DEFAULT_STOREFRONT_CUSTOMIZATION_MAX_LENGTH)) return `الحقل «${field.label}» يتجاوز الحد المسموح`;
    }
    return null;
  }, [customizationConfig, visibleCustomizationFields, customizationValues]);
  function updateCustomizationField(field: StorefrontCustomizationField, value: string) {
    setCustomizationDraft((previous) => {
      const values = { ...(previous.values ?? {}), [field.fieldKey]: value };
      const visibleKeys = storefrontVisibleCustomizationFieldKeys(customizationConfig?.fields ?? [], values);
      for (const key of Object.keys(values)) if (!visibleKeys.has(key)) delete values[key];
      const next: StorefrontCustomization = { ...previous, templateId: customizationConfig?.id ?? previous.templateId, kind: customizationConfig?.kind ?? previous.kind, values };
      if (field.fieldKey === "service") {
        next.service = value;
        next.serviceLabel = field.options.find((option) => option.value === value)?.label;
      }
      if (field.fieldKey === "packaging") next.packaging = value as "standard" | "gift";
      if (field.fieldKey === "recipient") next.recipient = value;
      if (field.fieldKey === "message") next.message = value;
      if (field.fieldKey === "designFile") next.uploadName = value;
      return next;
    });
  }
  function selectedCustomization(): StorefrontCustomization | undefined {
    if (!customizationConfig) return undefined;
    const values = Object.fromEntries(visibleCustomizationFields.flatMap((field) => {
      const value = customizationValues[field.fieldKey]?.trim() ?? "";
      return value ? [[field.fieldKey, value]] : [];
    }));
    const selections = visibleCustomizationFields.flatMap((field) => {
      const value = values[field.fieldKey]?.trim() ?? "";
      if (!value) return [];
      return [{ fieldKey: field.fieldKey, label: field.label, value, displayValue: field.options.find((option) => option.value === value)?.label ?? value }];
    });
    const priceDelta = visibleCustomizationFields.reduce((sum, field) => {
      const value = values[field.fieldKey]?.trim() ?? "";
      if (!value) return sum;
      return sum + Number(field.priceDelta || 0) + Number(field.options.find((option) => option.value === value)?.priceDelta ?? 0);
    }, 0);
    return { ...customizationDraft, templateId: customizationConfig.id, kind: customizationConfig.kind, values, selections, priceDelta: priceDelta.toFixed(2) };
  }

  useEffect(() => {
    setSelectedStoreUnitId(null);
    setSelectedVariantId(null);
    setVariantQuantities(new Map());
    setCustomizationDraft({ templateId: 0, kind: "PRINT", values: {} });
    setCustomizationUploadState("idle");
  }, [selectedId]);

  useEffect(() => {
    if (labelQ.data) setPanel("label");
  }, [labelQ.data]);

  const items = useMemo(() => (catalogQ.data?.pages ?? []).flatMap((page) => page.items), [catalogQ.data]);
  useEffect(() => {
    const sentinel = catalogLoadMoreRef.current;
    if (!sentinel || !catalogQ.hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (shouldAutoLoadStorefrontNextPage({
          isIntersecting: entries.some((entry) => entry.isIntersecting),
          hasNextPage: catalogQ.hasNextPage,
          isFetchingNextPage: catalogQ.isFetchingNextPage,
          isError: catalogQ.isError,
        })) {
          void catalogQ.fetchNextPage();
        }
      },
      { rootMargin: "520px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [catalogQ.fetchNextPage, catalogQ.hasNextPage, catalogQ.isError, catalogQ.isFetchingNextPage]);
  // فشل صفحة لاحقة لا يمحو ما رآه الزائر بالفعل؛ حالة الخطأ الكاملة تخص الصفحة الأولى فقط.
  const catalogInitialError = catalogQ.isError && items.length === 0;
  const cats = categoriesQ.data ?? [];
  const offers = offersQ.data ?? [];
  const banners = bannersQ.data ?? [];
  const sourceFailures = collectStorefrontFailures({
    settings: settingsQ.isError,
    categories: categoriesQ.isError,
    offers: offersQ.isError,
    catalog: catalogInitialError,
  });
  const supportingFailures = sourceFailures.filter(
    (source) => source !== "catalog",
  );
  // توزيع البنرات على مواضعها الثلاثة (الصفوف القديمة بلا placement = رئيسي).
  const heroBanners = useMemo(() => banners.filter((b) => (b.placement ?? "HERO") === "HERO"), [banners]);
  const inlineBanners = useMemo(() => banners.filter((b) => b.placement === "INLINE"), [banners]);
  const announcement = settingsQ.data?.announcement ?? null;
  // الفشل المغلق: لا نسمح بإرسال طلب قبل معرفة حالة المتجر فعلياً. خطأ الإعدادات له
  // تنبيه مستقل أدناه، فلا يتنكر في هيئة «مفتوح» ولا «مغلق».
  const storeOpen = settingsQ.isSuccess && settingsQ.data.isOpen;
  const orderingEnabled =
    settingsQ.isSuccess && settingsQ.data.orderingEnabled === true;
  const activeCatName = useMemo(
    () => (categoryId == null ? null : cats.find((c) => c.id === categoryId)?.name ?? null),
    [categoryId, cats]
  );
  const brands = useMemo(
    () => Array.from(new Set([...(catalogQ.data?.pages[0]?.brands ?? []), ...(brand ? [brand] : [])])).sort((a, b) => a.localeCompare(b, 'ar')),
    [catalogQ.data?.pages[0]?.brands, brand]
  );
  const filteredItems = items;
  const hasRefinements = availability !== "IN_STOCK" || priceFilter !== "ALL" || brand !== "" || sort !== "RECOMMENDED" || showWishlist || selectedThematicCollection != null;
  const searchScope = { categoryId, availability, brand, priceFilter, productIds: searchProductIds };
  function submitStoreSearch(query: string, selectedCategory?: number) {
    setRawSearch(query); setSearch(query.trim());
    if (selectedCategory != null) setCategoryId(selectedCategory);
    scrollToResults();
  }
  // All catalog refinements and ordering are applied by the server before cursor pagination.
  const isEmptyCatalog = items.length === 0 && !search && categoryId == null && !hasRefinements;

  function scrollToResults() {
    window.setTimeout(() => document.getElementById("store-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
  function selectCategory(id: number | null) {
    setSelectedThematicCollection(null);
    setCategoryId(id);
    scrollToResults();
  }
  function handleSelectThematicCollection(card: ThematicCollectionCard) {
    setSelectedThematicCollection(card);
    setCategoryId(null);
    setSearch("");
    setRawSearch("");
    scrollToResults();
  }
  function handleClearThematicCollection() {
    setSelectedThematicCollection(null);
    clearCatalogFilters();
  }
  function clearRefinements() {
    setAvailability("IN_STOCK");
    setPriceFilter("ALL");
    setBrand("");
    setSort("RECOMMENDED");
    setSelectedThematicCollection(null);
    setShowWishlist(false);
  }
  function clearCatalogFilters() {
    setRawSearch("");
    setSearch("");
    setCategoryId(null);
    setSelectedThematicCollection(null);
    clearRefinements();
  }
  function retrySupportingSources() {
    const retries: Promise<unknown>[] = [];
    if (settingsQ.isError) retries.push(settingsQ.refetch());
    if (categoriesQ.isError) retries.push(categoriesQ.refetch());
    if (offersQ.isError) retries.push(offersQ.refetch());
    void Promise.allSettled(retries);
  }
  // فواصل السيل التسويقية: بنرات INLINE المُدارة أولاً، وعند غيابها تُشتقّ من عروض اليوم الفعّالة
  // (فلسفة in-feed العالمية: لا يمرّ الزبون بأكثر من ~عشرة منتجات دون محفّز شراء).
  const feedStrips = useMemo<BannerItem[]>(() => {
    if (inlineBanners.length) return inlineBanners;
    if (offers.length) {
      return offers.slice(0, 4).map((o) => ({
        id: -o.id,
        title: o.name,
        subtitle: o.type === "PERCENT" ? `خصم ${Number(o.discountPercent)}٪` : `خصم ${money(o.discountAmount)} د.ع`,
        ctaLabel: "عرض اليوم",
      }));
    }
    // إذا لم تُعرّف لوحة الإدارة مواضع INLINE بعد، نعيد استخدام حملات HERO الحقيقية
    // في الفواصل البينية حتى لا يبقى مسار الشراء بلا محفّز ترويجي.
    return heroBanners.slice(1, 4);
  }, [heroBanners, inlineBanners, offers]);
  const topBanners = heroBanners.length ? heroBanners : feedStrips;
  const topBannerSlot = heroBanners.length || !inlineBanners.length ? "HERO" : "INLINE";

  const dealProducts = useMemo(
    () => items.filter((p) => p.inStock && p.salePrice != null && p.price != null && Number(p.salePrice) < Number(p.price)).slice(0, 12),
    [items]
  );
  const dealProductIds = useMemo(() => new Set(dealProducts.map((p) => p.productId)), [dealProducts]);
  const bestSellers = useMemo(
    () => [...items]
      .filter((p) => p.inStock && !dealProductIds.has(p.productId))
      .sort((a, b) => ((b.soldCount ?? 0) - (a.soldCount ?? 0)) || (b.productId - a.productId))
      .slice(0, 12),
    [dealProductIds, items]
  );

  const cartLines = useMemo(() => Array.from(cart.values()), [cart]);
  const { pulseHeart, toggleWishlist, shareProduct, shareCart } = storefrontSharingActions({setHeartPulseTarget, setHeartPulseNonce, setSharePulseTarget, setSharePulseNonce, setWishlistIds, setShareFeedback, cartLines, createCartShareM});
  const productCartQuantities = useMemo(() => summarizeStorefrontProductCartQuantities(cart), [cart]);
  const getProductCartQty = (id: number) => productCartQuantities.get(id)?.totalQty ?? 0;
  const handleProductQuantityDelta = (id: number, delta: number) => {
    applyStorefrontProductQuantityDelta(cartRef.current, null, id, delta, {
      setQty,
      openProduct,
      openCart: () => {
        setCartStatus("يوجد أكثر من خيار لهذا المنتج في السلة؛ عدّل الكمية من السلة.");
        setPanel("cart");
      },
    });
  };
  const lastAddedItem = useMemo(() => cartLines[cartLines.length - 1] ?? null, [cartLines]);
  const cartHasCustomization = cartLines.some((line) => Boolean(line.customization));
  const cartCount = cartLines.reduce((s, l) => s + l.qty, 0);
  const cartSubtotal = cartLines.reduce((s, l) => s + Number(l.price) * l.qty, 0);
  const deliveryFee = deliveryFeeFor(form.governorate);
  const freeThreshold = storefrontShippingThreshold(form.governorate, settingsQ.data?.freeShippingThreshold, settingsQ.data?.freeShippingThresholdGovernorates);
  const qualifiesFree = freeThreshold > 0 && cartSubtotal >= freeThreshold;
  const effectiveDeliveryFee = qualifiesFree ? 0 : deliveryFee;
  const remainingForFree = freeThreshold > 0 ? Math.max(freeThreshold - cartSubtotal, 0) : 0;
  const cartTotal = cartSubtotal + effectiveDeliveryFee;
  const quotedSubtotal = quoteQ.data?.subtotal ?? cartSubtotal.toFixed(2);
  const quotedDeliveryFee = quoteQ.data?.deliveryFee ?? effectiveDeliveryFee.toFixed(2);
  const quotedTotal = quoteQ.data?.total ?? cartTotal.toFixed(2);
  const quotedCouponDiscount = quoteQ.data?.couponDiscount ?? "0.00";
  const couponSuperseded = Boolean(quoteQ.data?.couponSuperseded);
  const couponForCheckout = couponSuperseded ? null : appliedCouponCode;
  const quotedDeliveryFree = quoteQ.data?.deliveryFree ?? qualifiesFree;
  const quoteReady = !!quoteQ.data && !quoteQ.isFetching && !quoteQ.isError;

  function addToCart(p: {
    productUnitId: number; productId: number; productName: string; price: string | null;
    salePrice?: string | null; imageUrl: string | null; unitName: string; variantLabel?: string; inStock?: boolean; isCustomizable?: boolean; customization?: StorefrontCustomization; stockLimit?: number | null;
  }, sourceElement?: HTMLElement | null) {
    const eff = p.salePrice ?? p.price;
    if (eff == null || !storefrontProductCanBeOrdered(p) || (p.isCustomizable && !p.customization)) return false;
    const cartKey = customizationCartKey(p.productUnitId, p.customization);
    const currentLine = cartRef.current.get(cartKey);
    if (p.stockLimit != null && (currentLine?.qty ?? 0) >= p.stockLimit) {
      setCartStatus(`بلغت الكمية المتوفرة من ${p.productName}: ${formatQuantity(p.stockLimit)}.`);
      return false;
    }
    if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "ADD_TO_CART" });
    recordStorefrontCartChange();
    const next = addStorefrontCartLine(cartRef.current, p, eff);
    cartRef.current = next;
    setCart(next);
    setCartStatus(`تمت إضافة ${p.productName} إلى السلة.`);
    return true;
  }
  function addFeaturedToCart(p: RowProduct, event: React.MouseEvent<HTMLButtonElement>) {
    return addCatalogProduct(p, event);
  }
  function addCatalogProduct(p: StorefrontProductForCartAction, event: React.MouseEvent<HTMLButtonElement>): boolean {
    if (!storefrontProductCanBeOrdered(p)) { openProduct(p.productId); return false; }
    const availableUnits = [...(p.storeUnits ?? []), ...(p.variants ?? []).flatMap((variant) => variant.units)].filter((unit) => unit.inStock);
    if (recommendationNeedsSelection(p) || availableUnits.length > 1) { openProduct(p.productId); return false; }
    const unit = availableUnits[0];
    const added = unit ? addToCart({
      productUnitId: unit.productUnitId, productId: p.productId, productName: p.productName,
      price: unit.price, salePrice: unit.salePrice, imageUrl: p.imageUrl, unitName: unit.unitName,
      variantLabel: p.variants?.find((variant) => variant.units.some((candidate) => candidate.productUnitId === unit.productUnitId))?.label,
      inStock: unit.inStock, stockLimit: unit.stockLeft,
    }, event.currentTarget) : p.productUnitId > 0 ? addToCart({
      productUnitId: p.productUnitId, productId: p.productId, productName: p.productName,
      price: p.price, salePrice: p.salePrice, imageUrl: p.imageUrl, unitName: p.unitName,
      inStock: p.inStock, stockLimit: p.stockLeft,
    }, event.currentTarget) : false;
    if (added) {
      setRecentlyAddedProductId(p.productId);
      window.setTimeout(() => setRecentlyAddedProductId((current) => current === p.productId ? null : current), 1000);
    }
    return added;
  }

  function setVariantQuantity(productUnitId: number, quantity: number) {
    const unit = (detailQ.data?.variants ?? []).flatMap((variant) => variant.units).find((candidate) => candidate.productUnitId === productUnitId)
      ?? detailQ.data?.storeUnits?.find((candidate) => candidate.productUnitId === productUnitId);
    const stockLimit = unit?.stockLeft == null ? 999 : Math.max(1, Math.min(Math.floor(unit.stockLeft), 999));
    setVariantQuantities((previous) => {
      const next = new Map(previous);
      if (quantity <= 0) next.delete(productUnitId);
      else next.set(productUnitId, Math.min(Math.trunc(quantity), stockLimit));
      return next;
    });
  }
  function addSelectedVariants(sourceElement?: HTMLElement | null) {
    if (!detailQ.data || !storefrontProductCanBeOrdered(detailQ.data) || isCustomizationUploadBlockingAddToCart(customizationUploadState) || customizationValidation || (detailQ.data.isCustomizable && !customizationConfig)) return false;
    const selections: StorefrontCartSelection[] = [];
    const customization = selectedCustomization();
    for (const variant of detailQ.data.variants ?? []) {
      // كل وحدة بيع لها مخزون وسعر مستقلان: نضيف كل لون/قياس/تعبئة اختار الزبون كخط مستقل.
      for (const unit of variant.units) {
        const quantity = variantQuantities.get(unit.productUnitId) ?? 0;
        const basePrice = unit.salePrice ?? unit.price;
        if (!unit.inStock || !basePrice || quantity <= 0) continue;
        const effectivePrice = (Number(basePrice) + Number(customization?.priceDelta ?? 0)).toFixed(2);
        selections.push({
          productUnitId: unit.productUnitId,
          productId: detailQ.data.productId,
          productName: detailQ.data.productName,
          imageUrl: variant.imageUrl ?? detailQ.data.imageUrl,
          unitName: unit.unitName,
          variantLabel: variant.label,
          isCustomizable: detailQ.data.isCustomizable,
          customization,
          effectivePrice,
          quantity,
          stockLimit: unit.stockLeft,
        });
      }
    }
    return commitCartSelections(selections);
  }
  function addSelectedUnit(sourceElement?: HTMLElement | null) {
    if (!detailQ.data || !storefrontProductCanBeOrdered(detailQ.data) || !detailUnit || !detailUnit.inStock || isCustomizationUploadBlockingAddToCart(customizationUploadState) || customizationValidation || (detailQ.data.isCustomizable && !customizationConfig)) return false;
    const basePrice = detailUnit.salePrice ?? detailUnit.price;
    if (!basePrice) return false;
    const customization = selectedCustomization();
    const effectivePrice = (Number(basePrice) + Number(customization?.priceDelta ?? 0)).toFixed(2);
    const quantity = Math.max(1, variantQuantities.get(detailUnit.productUnitId) ?? 1);
    const selection: StorefrontCartSelection = {
      productUnitId: detailUnit.productUnitId,
      productId: detailQ.data.productId,
      productName: detailQ.data.productName,
      imageUrl: detailVariant?.imageUrl ?? detailQ.data.imageUrl,
      unitName: detailUnit.unitName,
      variantLabel: detailVariant?.label,
      isCustomizable: detailQ.data.isCustomizable,
      customization,
      effectivePrice,
      quantity,
      stockLimit: detailUnit.stockLeft,
    };
    return commitCartSelections([selection]);
  }
  function commitCartSelections(selections: StorefrontCartSelection[]): boolean {
    if (!selections.length) return false;
    const previous = cartRef.current;
    const next = addStorefrontCartLines(previous, selections);
    const changed = Array.from(next).some(([key, line]) => (previous.get(key)?.qty ?? 0) < line.qty);
    if (!changed) { setCartStatus("بلغت الكمية المتوفرة من الاختيارات المحددة."); return false; }
    if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "ADD_TO_CART" });
    recordStorefrontCartChange();
    cartRef.current = next;
    setCart(next);
    setCartStatus("تمت إضافة الاختيارات إلى السلة.");
    return true;
  }
  function setQty(cartKey: string, qty: number) {
    const line = cartRef.current.get(cartKey);
    if (line?.stockLimit != null && qty > line.stockLimit) {
      setCartStatus(`المتوفر من ${line.name} هو ${formatQuantity(line.stockLimit)} فقط.`);
    } else if (line) {
      setCartStatus(qty <= 0 ? `تمت إزالة ${line.name} من السلة.` : `أصبحت كمية ${line.name}: ${formatQuantity(Math.max(1, qty))}.`);
    }
    recordStorefrontCartChange();
    const next = setStorefrontCartQuantity(cartRef.current, cartKey, qty);
    cartRef.current = next;
    setCart(next);
  }
  function openCheckout() {
    if (!storeOpen || !orderingEnabled) return; // بوابتا المتجر والطلب ظاهرتان للزبون.
    if (hasStorefrontAnalyticsConsent()) trackConversion.mutate({ event: "BEGIN_CHECKOUT" });
    setTurnstileToken(null);
    setTurnstileResetKey((key) => key + 1);
    setPanel("checkout");
  }
  function updateCheckoutField<K extends keyof CheckoutForm>(field: K, value: CheckoutForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    const errorField: keyof CheckoutFieldErrors | null =
      field === "notes" || field === "latitude" || field === "longitude"
        ? null
        : (field as keyof CheckoutFieldErrors);
    if (errorField) {
      setCheckoutErrors((current) => {
        if (!current[errorField]) return current;
        const next = { ...current };
        delete next[errorField];
        return next;
      });
    }
  }
  function submitOrder() {
    setCheckoutSafetyError(null);
    const validationErrors = validateStorefrontCheckout(form);
    setCheckoutErrors(validationErrors);
    const firstError = (["name", "phone", "governorate", "address"] as const).find((field) => validationErrors[field]);
    if (firstError) {
      window.requestAnimationFrame(() => document.getElementById(`storefront-checkout-${firstError}`)?.focus());
      return;
    }
    const name = form.name.trim();
    const phone = form.phone.replace(/\s+/g, " ").trim();
    const address = form.address.trim();
    if (cartLines.length === 0) {
      setCheckoutSafetyError("السلة فارغة؛ أضف منتجاً قبل تأكيد الطلب.");
      return;
    }
    if (!quoteReady) {
      setCheckoutSafetyError("نحدّث السعر النهائي الآن؛ انتظر لحظة ثم أعد التأكيد.");
      return;
    }
    if (!orderingEnabled) {
      setCheckoutSafetyError("استقبال الطلبات متوقف مؤقتاً؛ يمكنك التواصل عبر واتساب.");
      return;
    }
    if (!settingsQ.data?.turnstileSiteKey || !turnstileToken) {
      setCheckoutSafetyError("أكمل التحقق الأمني قبل تأكيد الطلب.");
      return;
    }
    const fingerprint = storefrontCheckoutFingerprint(cart, form, couponForCheckout);
    const previous = checkoutAttemptRef.current;
    const acceptedQuote = acceptedQuoteRef.current?.fingerprint === fingerprint
      ? acceptedQuoteRef.current
      : null;
    const attempt: StorefrontCheckoutAttempt = previous?.fingerprint === fingerprint
      ? previous
      : {
          clientRequestId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? `sf-${crypto.randomUUID()}`
            : `sf-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
          fingerprint,
          expectedGrandTotal: acceptedQuote?.total ?? (quoteQ.data?.total ?? cartTotal.toFixed(2)),
          createdAt: Date.now(),
        };
    // fail-closed قبل الشبكة: الرد الضائع آمن فقط إذا بقي نفس المفتاح بعد reload/PWA.
    if (!saveStorefrontSnapshot(cart, form, localStorage, attempt)) {
      setCheckoutSafetyError("تعذّر تأمين رقم محاولة الطلب على هذا الجهاز — حرّر مساحة التخزين ثم أعد المحاولة.");
      return;
    }
    checkoutAttemptRef.current = attempt;
    setCheckoutAttempt(attempt);
    orderInFlightRef.current = true;
    createOrder.mutate({
      couponCode: couponForCheckout || undefined,
      customerName: name,
      customerPhone: phone,
      governorate: form.governorate,
      addressText: address,
      latitude: form.latitude ?? undefined,
      longitude: form.longitude ?? undefined,
      notes: form.notes.trim() || undefined,
      lines: cartLines.map((l, index) => ({
        productUnitId: l.productUnitId,
        quantity: l.qty,
        customization: buildStorefrontCustomizationPayload(l.customization),
        expectedUnitPrice: quoteQ.data?.lines[index]?.unitPrice ?? Number(l.price).toFixed(2),
      })),
      expectedGrandTotal: attempt.expectedGrandTotal,
      clientRequestId: attempt.clientRequestId,
      turnstileToken: turnstileToken!,
    });
  }

  const product = detailQ.data;
  const productLoading = detailQ.isLoading;
  const cartRecommendations = cartRecommendationsQ.data;
  const settings = settingsQ.data;
  const quoteData = quoteQ.data;
  const quoteFetching = quoteQ.isFetching, quoteError = quoteQ.isError, quoteErrorMessage = quoteQ.error?.message;
  const orderPending = createOrder.isPending, orderFailed = createOrder.isError, orderErrorMessage = createOrder.error?.message;
  const labelData = labelQ.data, labelLoading = labelQ.isLoading, labelFailed = labelQ.isError, labelErrorMessage = labelQ.error?.message;
  return (
    <div className="storefront min-h-dvh overflow-x-clip bg-[#FFFBF7] text-[#183D36] dark:bg-slate-950 dark:text-slate-100" dir="rtl">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(254,243,199,0.22),rgba(255,255,255,0))] dark:hidden" />
      <StorefrontStickyFilter
        categories={cats.map((c: any) => ({ categoryId: c.id ?? c.categoryId, name: c.name }))}
        selectedCategoryId={categoryId}
        onSelectCategory={(id) => { setCategoryId(id); scrollToResults(); }}
        availability={availability}
        onToggleAvailability={() => { setAvailability((v) => v === "IN_STOCK" ? "ALL" : "IN_STOCK"); scrollToResults(); }}
        sort={sort}
        onChangeSort={(s) => { setSort(s as CatalogSort); scrollToResults(); }}
        totalCount={filteredItems.length}
        onScrollToTop={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      />
      <a href="#store-main" className="fixed right-4 z-[100] -translate-y-[160%] rounded-xl bg-blue-600 px-4 py-3 text-sm font-black text-white shadow-lg transition-transform focus:translate-y-0" style={{ top: "calc(.5rem + env(safe-area-inset-top))" }}>تجاوز إلى محتوى المتجر</a>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{cartStatus}</div>
      <StorefrontHeader categoryId={categoryId} search={search} setCategoryId={setCategoryId} setSearch={setSearch} setRawSearch={setRawSearch} rawSearch={rawSearch} submitStoreSearch={submitStoreSearch} openProduct={openProduct} searchScope={searchScope} pulseHeart={pulseHeart} setShowWishlist={setShowWishlist} showWishlist={showWishlist} heartPulseTarget={heartPulseTarget} heartPulseNonce={heartPulseNonce} wishlistIds={wishlistIds} setPanel={setPanel} cartCount={cartCount} cats={cats} selectCategory={selectCategory} />

      <StorefrontCatalogSurface announcement={announcement} shareFeedback={shareFeedback} settingsQ={settingsQ} storeOpen={storeOpen} cartSubtotal={cartSubtotal} settings={settings} search={search} categoryId={categoryId} showWishlist={showWishlist} topBanners={topBanners} topBannerSlot={topBannerSlot} cats={cats} selectCategory={selectCategory} availability={availability} selectedThematicCollection={selectedThematicCollection} handleSelectThematicCollection={handleSelectThematicCollection} handleClearThematicCollection={handleClearThematicCollection} activeCatName={activeCatName} filteredItems={filteredItems} setAvailability={setAvailability} scrollToResults={scrollToResults} priceFilter={priceFilter} setPriceFilter={setPriceFilter} brands={brands} brand={brand} setBrand={setBrand} sort={sort} setSort={setSort} setCatalogSeed={setCatalogSeed} hasRefinements={hasRefinements} clearCatalogFilters={clearCatalogFilters} catalogQ={catalogQ} catalogInitialError={catalogInitialError} isEmptyCatalog={isEmptyCatalog} submitStoreSearch={submitStoreSearch} openProduct={openProduct} searchScope={searchScope} wishlistIds={wishlistIds} recentlyAddedProductId={recentlyAddedProductId} heartPulseTarget={heartPulseTarget} heartPulseNonce={heartPulseNonce} sharePulseTarget={sharePulseTarget} sharePulseNonce={sharePulseNonce} addCatalogProduct={addCatalogProduct} toggleWishlist={toggleWishlist} shareProduct={shareProduct} getProductCartQty={getProductCartQty} handleProductQuantityDelta={handleProductQuantityDelta} feedStrips={feedStrips} inlineBanners={inlineBanners} catalogLoadMoreRef={catalogLoadMoreRef} />

      <div className="mx-auto max-w-6xl px-4">
        <StoreTrustAndHelp
          whatsappNumber={settings?.whatsappNumber}
          freeShippingThreshold={freeThreshold}
        />
      </div>

      {/* تذييل الموقع العام: كل ما يخدم الناس يعيش على هذا الدومين — المتجر والوظائف.
          هامش سفلي إضافي كي لا يحجبه شريط السلة العائم. */}
      <StorefrontFooter openTrack={openTrack} settings={settings} />

      {/* شريط السلة الذكي العائم — نمط عالمي في متناول الإبهام يظهر عند إضافة منتجات */}
      {panel == null && cartCount > 0 && (
        <StorefrontFloatingCart
          cartCount={cartCount}
          cartSubtotal={cartSubtotal}
          onOpenCart={() => setPanel("cart")}
        />
      )}

      {/* شارة «الخصوصية» ثابتة أسفل اليسار؛ نرفع واتساب 4rem حتى لا يتراكبا على الهاتف. */}
      {panel == null && cartCount === 0 && settings?.whatsappNumber && (
        <a
          href={`https://wa.me/${settings.whatsappNumber.replace(/[^\d]/g, "")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed left-4 z-20 flex min-h-11 items-center gap-2 rounded-full bg-[#168457] px-4 py-3 text-xs font-black text-white shadow-lg shadow-emerald-900/20 transition hover:-translate-y-0.5 hover:bg-[#116c49]"
          style={{ bottom: "calc(4rem + env(safe-area-inset-bottom))" }}
          aria-label="تواصل مع فريق المتجر عبر واتساب"
        >
          <MessageCircle aria-hidden className="size-4" /> اسألنا عبر واتساب
        </a>
      )}

      {/* تفاصيل المنتج (ورقة سفلية) */}
      <StorefrontProductDialog selectedId={selectedId} setSelectedId={setSelectedId} productDialogCloseRef={productDialogCloseRef} productDialogTriggerRef={productDialogTriggerRef} product={product} toggleWishlist={toggleWishlist} wishlistIds={wishlistIds} heartPulseTarget={heartPulseTarget} heartPulseNonce={heartPulseNonce} shareProduct={shareProduct} sharePulseTarget={sharePulseTarget} sharePulseNonce={sharePulseNonce} productLoading={productLoading} detailMedia={detailMedia} setProductReviewOpenRequest={setProductReviewOpenRequest} selectCategory={selectCategory} detailUnit={detailUnit} variantQuantities={variantQuantities} setSelectedVariantId={setSelectedVariantId} setSelectedStoreUnitId={setSelectedStoreUnitId} setVariantQuantity={setVariantQuantity} detailVariant={detailVariant} customizationConfig={customizationConfig} visibleCustomizationFields={visibleCustomizationFields} customizationValues={customizationValues} customizationValidation={customizationValidation} updateCustomizationField={updateCustomizationField} customizationUploadState={customizationUploadState} setCustomizationUploadState={setCustomizationUploadState} setCustomizationAssets={setCustomizationAssets} addSelectedVariants={addSelectedVariants} addSelectedUnit={addSelectedUnit} getProductCartQty={getProductCartQty} settings={settings} relatedQ={relatedQ} addCatalogProduct={addCatalogProduct} trackRecommendationClick={trackRecommendationClick} productReviewOpenRequest={productReviewOpenRequest} />

      {/* ═══ السلة ═══ */}
      {panel === "cart" && (
        <StorefrontCartPanel setPanel={setPanel} cartLines={cartLines} setQty={setQty} cartRecommendations={cartRecommendations} setSelectedId={setSelectedId} addFeaturedToCart={addFeaturedToCart} recentlyAddedProductId={recentlyAddedProductId} cartSubtotal={cartSubtotal} freeThreshold={freeThreshold} setShowWishlist={setShowWishlist} scrollToResults={scrollToResults} shareCart={shareCart} cartHasCustomization={cartHasCustomization} sharePulseTarget={sharePulseTarget} sharePulseNonce={sharePulseNonce} openCheckout={openCheckout} storeOpen={storeOpen} orderingEnabled={orderingEnabled} settingsQ={settingsQ} settings={settings} />
      )}

      {/* ═══ الدفع عند الاستلام ═══ */}
      {panel === "checkout" && (
        <StorefrontCheckoutPanel setTurnstileToken={setTurnstileToken} setCheckoutErrors={setCheckoutErrors} setPanel={setPanel} submitOrder={submitOrder} cartCount={cartCount} checkoutErrors={checkoutErrors} form={form} updateCheckoutField={updateCheckoutField} orderInFlightRef={orderInFlightRef} couponDraft={couponDraft} setCouponDraft={setCouponDraft} applyCoupon={applyCoupon} appliedCouponCode={appliedCouponCode} removeCoupon={removeCoupon} quoteFetching={quoteFetching} quoteError={quoteError} quoteErrorMessage={quoteErrorMessage} couponSuperseded={couponSuperseded} quoteData={quoteData} quotedCouponDiscount={quotedCouponDiscount} couponFeedback={couponFeedback} quotedSubtotal={quotedSubtotal} quotedDeliveryFree={quotedDeliveryFree} quotedDeliveryFee={quotedDeliveryFee} quotedTotal={quotedTotal} orderingEnabled={orderingEnabled} settings={settings} turnstileResetKey={turnstileResetKey} orderFailed={orderFailed} checkoutSafetyError={checkoutSafetyError} orderErrorMessage={orderErrorMessage} orderPending={orderPending} />
      )}

      {/* ═══ تأكيد الطلب ═══ */}
      {panel === "confirmation" && confirmation && (
        <StorefrontConfirmationPanel setPanel={setPanel} confirmation={confirmation} setConfirmation={setConfirmation} openTrack={openTrack} />
      )}

      {panel === "label" && (
        <StorefrontLabelPanel setPanel={setPanel} labelLoading={labelLoading} labelData={labelData} />
      )}

      {panel === "track" && (
        <StorefrontTrackingPanel setPanel={setPanel} trustedTrackingOrders={trustedTrackingOrders} doTrack={doTrack} trackState={trackState} trackToken={trackToken} setTrackToken={setTrackToken} setTrackError={setTrackError} setTrackState={setTrackState} trackError={trackError} settings={settings} trackResult={trackResult} openProduct={openProduct} />
      )}
    </div>
  );
}

export default function Storefront() {
  return (
    <ConsentProvider>
      <StorefrontContent />
      <ConsentChoice />
    </ConsentProvider>
  );
}
