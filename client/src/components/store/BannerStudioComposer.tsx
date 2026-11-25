/**
 * BannerStudioComposer — مساحة العمل الاحترافية الموحّدة لتصميم ونشر البنرات الإعلانية والحملات.
 *
 * المبادئ الحاكمة (بأسلوب الوكالات العالمية وحارس أمانة المنتج والنص):
 * 1. حارس ملامح المنتج والكتابة (100% Pixel-True Product Guard):
 *    الوضع الهجين والاستوديو الفوري يفرّغان الخلفية الخارجية حول المنتجات ويركّبان بكسلات المنتجات
 *    الأصلية المعتمدة كما هي دون أي إعادة رسم توليدي قد يشوّه شكل المنتج أو كتابة الغلاف أو الشعارات.
 * 2. دمج وتكتيل 1 إلى 5 منتجات في البنر الواحد مع تحديد «المنتج البطل» ودمج أصناف إضافية في أي وضع.
 * 3. ضبط الإضاءة (Softbox / Spotlight / Golden Sunbeam / Rim Glow) + 10 لوحات تدرج لوني + فعاليات تصميمية
 *    (منصة عرض 3D، أشعة وبوكيه، ختم السعر/العرض الدائري، وبطاقة نص زجاجية).
 * 4. بوابة أمانة صارمة قبل النشر: تمنع نشر أي رقم مخترع أو مبالغة أو انحراف عن هوية المنتج المختار.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  CheckCircle2,
  ChevronDown,
  Crown,
  Eye,
  EyeOff,
  Laptop,
  Layers,
  Loader2,
  Palette,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ImageUploader, type ImageItem } from "@/components/form/ImageUploader";
import {
  BANNER_STUDIO_PRESETS,
  BANNER_STUDIO_PRESET_IDS,
  DEFAULT_BANNER_SCENE_MODEL,
  validateBannerMarketingCopy,
  type BannerCompositionStyle,
  type BannerCopySourceFacts,
  type BannerCopyVariant,
  type BannerCreativeEffect,
  type BannerLightingMode,
  type BannerStudioPresetId,
  type BannerStudioProductPreview,
  type BannerTargetKind,
  type StudioBannerPlacement,
} from "@shared/imageStudio/bannerStudioContract";
import {
  composeStudioBannerPair,
  type ComposedBannerPair,
  type StudioVisualRenderMode,
} from "@/lib/imageStudio/bannerCanvasCompositor";
import {
  BannerSubjectPicker,
  inferSubjectStateFromBanner,
  type BannerSubjectState,
} from "@/components/store/BannerSubjectPicker";

export type BannerPlacementOption = "HERO" | "INLINE" | "SIDE";

export interface StoredBannerSlide {
  url: string;
  mobileUrl?: string | null;
  title?: string | null;
  subtitle?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface EditableBannerRecord {
  id: number;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  mobileImageUrl: string | null;
  images: unknown;
  ctaLabel: string | null;
  ctaUrl: string | null;
  sortOrder: number | null;
  isActive: boolean | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  placement: string | null;
  linkedPromoInactive?: boolean;
}

export interface BannerSavePayload {
  id?: number;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  mobileImageUrl: string | null;
  images: StoredBannerSlide[];
  ctaLabel: string | null;
  ctaUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  placement: BannerPlacementOption;
  renderMode: "PRESERVE_FULL";
  focusX: number;
  focusY: number;
}

interface BannerStudioComposerProps {
  editingBanner: EditableBannerRecord | null;
  initialPromoId: number | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (payload: BannerSavePayload) => void;
}

const DEFAULT_COPY: BannerCopyVariant = {
  eyebrow: "متجر المكتبة العربية",
  headline: "اختر منتجاً أو قسماً لإخراج بنره الإعلاني فوراً",
  subtitle: "سحب فوري لصور المنتجات المتوفرة وأسعارها الحقيقية مع حراسة تامة لملامح المنتج والنص",
  ctaLabel: "تسوّق الآن",
  priceBadge: null,
};

const LIGHTING_OPTIONS: Array<{ id: BannerLightingMode; labelAr: string }> = [
  { id: "STUDIO_SOFTBOX", labelAr: "إضاءة Apple الناعمة" },
  { id: "DRAMATIC_SPOTLIGHT", labelAr: "تركيز علوي هادئ" },
  { id: "GOLDEN_SUNBEAM", labelAr: "ضوء نهاري طبيعي" },
  { id: "NEON_RIM_GLOW", labelAr: "تباين محيطي خفيف" },
];

const COMPOSITION_OPTIONS: Array<{ id: BannerCompositionStyle; labelAr: string }> = [
  { id: "HERO_ENSEMBLE", labelAr: "منظور وكالة بانورامي (قوس 3D)" },
  { id: "PODIUM_SHOWCASE", labelAr: "مسرح منصّات متدرّج (85mm)" },
  { id: "DYNAMIC_CASCADE", labelAr: "لقطة عائمة ديناميكية" },
  { id: "CLEAN_GRID", labelAr: "شبكة Bento منظّمة" },
];

const SCALE_OPTIONS: Array<{ value: number; labelAr: string }> = [
  { value: 1.0, labelAr: "متوازن" },
  { value: 1.1, labelAr: "بارز وواضح" },
  { value: 1.18, labelAr: "مكبّر تسويقياً" },
];

const EFFECT_OPTIONS: Array<{ id: BannerCreativeEffect; labelAr: string }> = [
  { id: "PODIUM_3D", labelAr: "منصة Apple نحيفة" },
  { id: "LIGHT_RAYS", labelAr: "نسيم ضوء نهاري" },
  { id: "PROMO_SEAL", labelAr: "كبسولة سعر زجاجية" },
  { id: "GLASS_CARD", labelAr: "لوح نص زجاجي" },
];

function parseStoredSlides(banner: EditableBannerRecord | null): StoredBannerSlide[] {
  if (!banner) return [];
  if (Array.isArray(banner.images)) {
    const valid = (banner.images as StoredBannerSlide[]).filter((s) => s && typeof s.url === "string" && s.url);
    if (valid.length > 0) return valid;
  }
  return banner.imageUrl
    ? [{ url: banner.imageUrl, mobileUrl: banner.mobileImageUrl, ctaUrl: banner.ctaUrl, isActive: true, sortOrder: 0 }]
    : [];
}

export function BannerStudioComposer({
  editingBanner,
  initialPromoId,
  saving,
  onCancel,
  onSubmit,
}: BannerStudioComposerProps) {
  const initialSlides = useMemo(() => parseStoredSlides(editingBanner), [editingBanner]);
  const hasStoredCreative = initialSlides.length > 0;

  const [subject, setSubject] = useState<BannerSubjectState>(() => {
    if (initialPromoId) {
      return {
        mode: "PROMOTION",
        products: [],
        categoryId: null,
        promotionId: initialPromoId,
        specialTarget: "NONE",
        ctaUrl: `/store?promo=${initialPromoId}`,
      };
    }
    if (editingBanner) {
      return inferSubjectStateFromBanner({
        ctaUrl: editingBanner.ctaUrl,
        hasUploadedImages: hasStoredCreative,
      });
    }
    return { mode: "PRODUCTS", products: [], categoryId: null, promotionId: null, specialTarget: "NONE", ctaUrl: "/store" };
  });

  const [campaignSlides, setCampaignSlides] = useState<StoredBannerSlide[]>([]);
  const [placement, setPlacement] = useState<BannerPlacementOption>(
    (editingBanner?.placement as BannerPlacementOption) ?? "HERO",
  );
  const [presetId, setPresetId] = useState<BannerStudioPresetId>("CLEAN_MINIMAL_APPLE");
  const [presetLockedByUser, setPresetLockedByUser] = useState(false);

  const [visualMode, setVisualMode] = useState<StudioVisualRenderMode>("LOCAL_STUDIO");
  const [lightingMode, setLightingMode] = useState<BannerLightingMode>("STUDIO_SOFTBOX");
  const [compositionStyle, setCompositionStyle] = useState<BannerCompositionStyle>("HERO_ENSEMBLE");
  const [productScale, setProductScale] = useState<number>(1.1);
  const [effects, setEffects] = useState<BannerCreativeEffect[]>([]);

  const [sceneHint, setSceneHint] = useState("");
  const [previewViewport, setPreviewViewport] = useState<"DESKTOP" | "MOBILE">("DESKTOP");

  const [natureLabelAr, setNatureLabelAr] = useState<string | null>(null);
  const [facts, setFacts] = useState<BannerCopySourceFacts | null>(null);
  const [variants, setVariants] = useState<BannerCopyVariant[]>([]);
  const [pulledProducts, setPulledProducts] = useState<BannerStudioProductPreview[]>([]);
  const [extraMergedProducts, setExtraMergedProducts] = useState<BannerStudioProductPreview[]>([]);
  const [orderedProductIds, setOrderedProductIds] = useState<number[]>([]);
  const [excludedProductIds, setExcludedProductIds] = useState<number[]>([]);
  const [showAddProductPicker, setShowAddProductPicker] = useState(false);
  const [extraSearchQuery, setExtraSearchQuery] = useState("");

  const [copy, setCopy] = useState<BannerCopyVariant>(() =>
    editingBanner
      ? {
          eyebrow: "متجر المكتبة العربية",
          headline: editingBanner.title,
          subtitle: editingBanner.subtitle ?? "",
          ctaLabel: editingBanner.ctaLabel || "تسوّق الآن",
          priceBadge: null,
        }
      : DEFAULT_COPY,
  );
  const [aiSceneDataUrl, setAiSceneDataUrl] = useState<string | null>(null);
  const [composed, setComposed] = useState<ComposedBannerPair | null>(null);
  const [composing, setComposing] = useState(false);

  const [uploadedDesktop, setUploadedDesktop] = useState<ImageItem[]>(() =>
    initialSlides.map((s, idx) => ({ id: `s-${idx}`, dataUrl: s.url, isPrimary: idx === 0 })),
  );
  const [uploadedMobile, setUploadedMobile] = useState<ImageItem[]>(() => {
    const initialMob =
      editingBanner?.mobileImageUrl ?? (initialSlides.length === 1 ? (initialSlides[0]?.mobileUrl ?? null) : null);
    return initialMob ? [{ id: "mob", dataUrl: initialMob, isPrimary: true }] : [];
  });
  const [sortOrder, setSortOrder] = useState(String(editingBanner?.sortOrder ?? 0));
  const [effectiveFrom, setEffectiveFrom] = useState(editingBanner?.effectiveFrom ?? "");
  const [effectiveTo, setEffectiveTo] = useState(editingBanner?.effectiveTo ?? "");
  const [isActive, setIsActive] = useState(editingBanner ? Boolean(editingBanner.isActive) : true);

  const aiConfigQ = trpc.imageStudio.aiConfig.useQuery();
  const extraProductsQ = trpc.storeAdmin.banners.products.useQuery(
    {
      q: extraSearchQuery.trim() || undefined,
      categoryId: subject.mode === "CATEGORY" && subject.categoryId ? subject.categoryId : undefined,
      limit: 10,
    },
    { enabled: showAddProductPicker && subject.mode !== "UPLOAD" },
  );

  const presetLockRef = useRef(presetLockedByUser);
  presetLockRef.current = presetLockedByUser;

  const generateCopyM = trpc.storeAdmin.banners.generateCopy.useMutation({
    onError: (err) => notify.err(err),
  });

  const generateSceneM = trpc.storeAdmin.banners.generateImage.useMutation({
    onSuccess: (res, vars) => {
      setAiSceneDataUrl(res.sceneDataUrl);
      setVisualMode(vars.sceneMode === "FULL_SCENE" ? "AI_FULL_SCENE" : "HYBRID_STAGE");
      notify.ok(
        vars.sceneMode === "FULL_SCENE"
          ? "تم توليد المشهد الفوتوغرافي المرجعي بنجاح"
          : "تم تجهيز منصة الاستوديو السينمائية مع حفظ أصل المنتجات 100%",
      );
    },
    onError: (err) => notify.err(err),
  });

  const subjectSignature = useMemo(() => {
    if (subject.mode === "UPLOAD") return "";
    if (subject.mode === "PRODUCTS") {
      const ids = subject.products.map((p) => p.productId).join(",");
      return ids ? `PRODUCTS:${ids}` : "";
    }
    if (subject.mode === "CATEGORY") return subject.categoryId ? `CATEGORY:${subject.categoryId}` : "";
    if (subject.specialTarget === "DEALS") return "DEALS:ALL";
    if (subject.specialTarget === "QUOTE") return "QUOTE:ALL";
    return subject.promotionId ? `PROMOTION:${subject.promotionId}` : "";
  }, [subject.mode, subject.products, subject.categoryId, subject.promotionId, subject.specialTarget]);

  const latestSubjectSigRef = useRef(subjectSignature);
  latestSubjectSigRef.current = subjectSignature;
  const copyReqSeqRef = useRef(0);
  const initialEditSigRef = useRef<string | null>(editingBanner ? subjectSignature : null);

  // منع بقاء أي مشهد قديم عند تغيير الفئة أو المنتجات أو العرض الترويجي، وتجاهل الردود المتأخرة، وحفظ نص البنر المحرّر عند الفتح الأولي
  useEffect(() => {
    if (!subjectSignature) {
      copyReqSeqRef.current += 1;
      return;
    }
    const isInitialEditFetch =
      initialEditSigRef.current !== null && initialEditSigRef.current === subjectSignature;
    if (!isInitialEditFetch) {
      initialEditSigRef.current = null;
    }

    setAiSceneDataUrl(null);
    setExtraMergedProducts([]);
    setOrderedProductIds([]);
    setExcludedProductIds([]);
    if (visualMode === "AI_FULL_SCENE") {
      setVisualMode("HYBRID_STAGE");
    }

    const reqId = ++copyReqSeqRef.current;
    const reqSig = subjectSignature;

    const timer = window.setTimeout(() => {
      const targetKind: BannerTargetKind =
        subject.mode === "PRODUCTS"
          ? "PRODUCTS"
          : subject.mode === "CATEGORY"
            ? "CATEGORY"
            : subject.specialTarget === "QUOTE"
              ? "QUOTE"
              : subject.specialTarget === "DEALS"
                ? "DEALS"
                : "PROMOTION";

      void generateCopyM
        .mutateAsync({
          targetKind,
          promotionId: targetKind === "PROMOTION" ? subject.promotionId : null,
          categoryId: targetKind === "CATEGORY" ? subject.categoryId : null,
          productIds: targetKind === "PRODUCTS" ? subject.products.map((p) => p.productId) : undefined,
        })
        .then((res) => {
          if (reqId !== copyReqSeqRef.current || reqSig !== latestSubjectSigRef.current) {
            return;
          }
          setFacts(res.facts);
          setNatureLabelAr(res.natureLabelAr);
          setVariants(res.variants);
          setPulledProducts(res.products);
          setOrderedProductIds(res.products.map((p) => p.productId));
          setExcludedProductIds([]);
          if (!presetLockRef.current) setPresetId(res.recommendedPresetId);
          if (!isInitialEditFetch) {
            if (res.variants[0]) setCopy(res.variants[0]);
            if (res.facts.ctaUrl) {
              setSubject((prev) =>
                prev.ctaUrl === res.facts.ctaUrl ? prev : { ...prev, ctaUrl: res.facts.ctaUrl },
              );
            }
          }
          if (res.facts.effectiveTo) {
            setEffectiveTo((prev) => prev || res.facts.effectiveTo || "");
          }
        })
        .catch(() => {
          /* onError handles toast */
        });
    }, 180);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectSignature]);

  const combinedCandidateProducts = useMemo(() => {
    const base =
      pulledProducts.length > 0
        ? pulledProducts
        : subject.products.map((p) => ({
            productId: p.productId,
            name: p.name,
            categoryId: null,
            categoryName: p.categoryName ?? null,
            brand: null,
            priceText: p.priceText ?? null,
            imageUrl: p.imageUrl ?? null,
          }));
    const map = new Map<number, BannerStudioProductPreview>();
    for (const item of [...base, ...extraMergedProducts]) {
      if (!map.has(item.productId)) map.set(item.productId, item);
    }
    const ordered: BannerStudioProductPreview[] = [];
    for (const id of orderedProductIds) {
      const found = map.get(id);
      if (found) {
        ordered.push(found);
        map.delete(id);
      }
    }
    for (const rest of Array.from(map.values())) ordered.push(rest);
    return ordered.slice(0, 6);
  }, [pulledProducts, subject.products, extraMergedProducts, orderedProductIds]);

  const activeProductItems = useMemo(
    () => combinedCandidateProducts.filter((p) => !excludedProductIds.includes(p.productId)).slice(0, 5),
    [combinedCandidateProducts, excludedProductIds],
  );

  const activeProductImageUrls = useMemo(
    () =>
      activeProductItems
        .map((p) => p.imageUrl)
        .filter((u): u is string => Boolean(u))
        .slice(0, 5),
    [activeProductItems],
  );

  function promoteProductToHero(productId: number) {
    setExcludedProductIds((prev) => prev.filter((id) => id !== productId));
    setOrderedProductIds(() => {
      const currentIds = combinedCandidateProducts.map((p) => p.productId);
      return [productId, ...currentIds.filter((id) => id !== productId)];
    });
  }

  function addExtraProductToEnsemble(prod: BannerStudioProductPreview) {
    setExcludedProductIds((prev) => prev.filter((id) => id !== prod.productId));
    setExtraMergedProducts((prev) =>
      prev.some((p) => p.productId === prod.productId) ? prev : [...prev, prod].slice(0, 5),
    );
    setOrderedProductIds((prev) => {
      const baseIds = prev.length > 0 ? prev : combinedCandidateProducts.map((p) => p.productId);
      return baseIds.includes(prod.productId) ? baseIds : [...baseIds, prod.productId];
    });
  }

  function toggleCreativeEffect(effect: BannerCreativeEffect) {
    setEffects((prev) => (prev.includes(effect) ? prev.filter((e) => e !== effect) : [...prev, effect]));
  }

  const studioPlacement: StudioBannerPlacement = placement === "INLINE" ? "INLINE" : "HERO";

  useEffect(() => {
    if (subject.mode === "UPLOAD") return;
    let cancelled = false;
    setComposing(true);
    const effectiveVisualMode: StudioVisualRenderMode =
      visualMode !== "LOCAL_STUDIO" && aiSceneDataUrl ? visualMode : "LOCAL_STUDIO";

    const timer = window.setTimeout(() => {
      void composeStudioBannerPair({
        presetId,
        placement: studioPlacement,
        visualMode: effectiveVisualMode,
        sceneDataUrl: effectiveVisualMode !== "LOCAL_STUDIO" ? aiSceneDataUrl : null,
        productImageUrls: activeProductImageUrls,
        lightingMode,
        compositionStyle,
        productScale,
        effects,
        copy,
      })
        .then((pair) => {
          if (!cancelled) setComposed(pair);
        })
        .finally(() => {
          if (!cancelled) setComposing(false);
        });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    subject.mode,
    presetId,
    studioPlacement,
    visualMode,
    aiSceneDataUrl,
    activeProductImageUrls,
    lightingMode,
    compositionStyle,
    productScale,
    effects,
    copy,
  ]);

  const copyCheck = useMemo(() => {
    if (!facts) return { ok: true, sanitized: copy, issues: [] as string[] };
    return validateBannerMarketingCopy(copy, facts);
  }, [copy, facts]);

  function restoreVerifiedCopy() {
    if (variants[0]) {
      setCopy(variants[0]);
      notify.ok("تمت استعادة الصياغة الموثّقة المطابقة للمنتج وقاعدة البيانات");
    } else if (facts) {
      setCopy(copyCheck.sanitized);
    }
  }

  function stageCurrentSlideIntoTray() {
    if (!composed?.desktopDataUrl || !composed.mobileDataUrl) return;
    if (!copyCheck.ok) {
      notify.err("حارس أمانة المنتج والنص منع تثبيت الشريحة: عالج تنبيه النص أولاً أو اضغط «استعادة الصياغة الموثّقة».");
      return;
    }
    if (campaignSlides.length >= 12) {
      notify.err("الحد الأقصى لشرائح الحملة الواحدة في الاستوديو هو 12 شريحة.");
      return;
    }
    const safeCopy = copyCheck.sanitized;
    const nextSlide: StoredBannerSlide = {
      url: composed.desktopDataUrl,
      mobileUrl: composed.mobileDataUrl,
      title: safeCopy.headline.trim() || "شريحة ترويجية",
      subtitle: safeCopy.subtitle.trim() || null,
      ctaLabel: null,
      ctaUrl: subject.ctaUrl.trim() || "/store",
      isActive: true,
      sortOrder: campaignSlides.length,
    };
    setCampaignSlides((prev) => [...prev, nextSlide]);
    notify.ok("أُضيفت الشريحة لحملة الكاروسيل — اختر منتجاً أو فئة أخرى لتصميم الشريحة التالية أو اضغط نشر");
  }

  function handlePublish() {
    const title = copy.headline.trim() || campaignSlides[0]?.title?.trim() || "";
    if (!title) {
      notify.err("يرجى كتابة عنوان البنر أولاً.");
      return;
    }

    if (subject.mode !== "UPLOAD" && !copyCheck.ok) {
      notify.err("حارس أمانة المنتج والنص أوقف النشر لحماية المتجر من الهلوسة أو الأرقام غير الموثّقة.");
      return;
    }

    if (subject.mode === "UPLOAD") {
      const firstDesktop = uploadedDesktop[0]?.dataUrl ?? uploadedDesktop[0]?.url ?? null;
      if (!firstDesktop) {
        notify.err("يرجى رفع صورة البنر أولاً أو التبديل إلى استوديو التصميم.");
        return;
      }
      const singleMob = uploadedMobile[0]?.dataUrl ?? uploadedMobile[0]?.url ?? null;
      onSubmit({
        ...(editingBanner ? { id: editingBanner.id } : {}),
        title,
        subtitle: copy.subtitle.trim() || null,
        imageUrl: firstDesktop,
        mobileImageUrl: uploadedDesktop.length <= 1 ? singleMob : null,
        images: uploadedDesktop
          .map((item, idx) => {
            const url = item.dataUrl || item.url || "";
            const prevMeta = initialSlides.find((s) => s.url === url);
            return {
              url,
              mobileUrl: prevMeta?.mobileUrl ?? (uploadedDesktop.length === 1 ? singleMob : null),
              title: prevMeta?.title ?? null,
              subtitle: prevMeta?.subtitle ?? null,
              ctaLabel: prevMeta?.ctaLabel ?? null,
              ctaUrl: prevMeta?.ctaUrl ?? (subject.ctaUrl || null),
              effectiveFrom: prevMeta?.effectiveFrom ?? null,
              effectiveTo: prevMeta?.effectiveTo ?? null,
              isActive: prevMeta?.isActive !== false,
              sortOrder: idx,
            };
          })
          .filter((i) => i.url),
        ctaLabel: null,
        ctaUrl: subject.ctaUrl.trim() || null,
        sortOrder: Number(sortOrder) || 0,
        isActive,
        effectiveFrom: effectiveFrom || null,
        effectiveTo: effectiveTo || null,
        placement,
        renderMode: "PRESERVE_FULL",
        focusX: 50,
        focusY: 50,
      });
      return;
    }

    if (!composed?.desktopDataUrl && campaignSlides.length === 0) {
      notify.err("انتظر لحظة حتى تكتمل معاينة البنر.");
      return;
    }

    const safeCopy = copyCheck.sanitized;
    const currentStudioSlide: StoredBannerSlide | null = composed
      ? {
          url: composed.desktopDataUrl,
          mobileUrl: composed.mobileDataUrl,
          title: safeCopy.headline.trim(),
          subtitle: safeCopy.subtitle.trim() || null,
          ctaLabel: null,
          ctaUrl: subject.ctaUrl.trim() || "/store",
          isActive: true,
          sortOrder: campaignSlides.length,
        }
      : null;

    const finalSlides =
      campaignSlides.length > 0
        ? currentStudioSlide && !campaignSlides.some((s) => s.url === currentStudioSlide.url)
          ? [...campaignSlides, currentStudioSlide]
          : campaignSlides
        : currentStudioSlide
          ? [currentStudioSlide]
          : [];

    const first = finalSlides[0]!;
    onSubmit({
      ...(editingBanner ? { id: editingBanner.id } : {}),
      title: first.title?.trim() || title,
      subtitle: first.subtitle ?? (safeCopy.subtitle.trim() || null),
      imageUrl: first.url,
      mobileImageUrl: finalSlides.length === 1 ? (first.mobileUrl ?? null) : null,
      images: finalSlides.map((s, idx) => ({ ...s, sortOrder: idx })),
      ctaLabel: null,
      ctaUrl: first.ctaUrl ?? (subject.ctaUrl.trim() || "/store"),
      sortOrder: Number(sortOrder) || 0,
      isActive,
      effectiveFrom: effectiveFrom || null,
      effectiveTo: effectiveTo || null,
      placement: placement === "SIDE" ? "HERO" : placement,
      renderMode: "PRESERVE_FULL",
      focusX: 50,
      focusY: 50,
    });
  }

  return (
    <div className="rounded-2xl border border-primary/25 bg-card p-4 shadow-xs">
      <div className="mb-4 flex items-center justify-between gap-2 border-b border-border pb-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold">
            <Palette aria-hidden className="size-4 text-primary" />
            {editingBanner ? `تعديل البنر: ${editingBanner.title}` : "استوديو الإخراج الفني وتصميم البنرات"}
          </h3>
          <p className="text-xs text-muted-foreground">
            يدمج حتى 5 منتجات حقيقية مع حراسة تامة لملامح الصنف والغلاف، وضبط الإضاءة والتدرج اللوني والتأثيرات التسويقية.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="إغلاق مساحة التصميم"
          className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-accent"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-7">
          {/* القسم 1: اختيار الهدف + دمج المنتجات وتحديد البطل */}
          <section className="space-y-2.5 rounded-xl border border-border bg-muted/15 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold text-foreground">1. عن ماذا يتحدث البنر؟</span>
              {generateCopyM.isPending && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
                  <Loader2 aria-hidden className="size-3 animate-spin" />
                  جارٍ سحب صور الأصناف الموثّقة وضبط الهوية…
                </span>
              )}
            </div>

            <BannerSubjectPicker value={subject} onChange={setSubject} />

            {subject.mode !== "UPLOAD" && (natureLabelAr || combinedCandidateProducts.length > 0) && (
              <div className="space-y-2 rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] p-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-bold text-[var(--sem-pos)]">
                    <Layers aria-hidden className="size-3.5 shrink-0" />
                    {natureLabelAr ? `التصنيف الإعلاني: ${natureLabelAr}` : "المنتجات المدمجة في التكوين الإعلاني"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowAddProductPicker((prev) => !prev)}
                    className="inline-flex items-center gap-1 rounded-lg border border-primary/30 bg-background px-2 py-1 text-[11px] font-bold text-primary transition hover:bg-primary/10"
                  >
                    <Plus aria-hidden className="size-3" />
                    دمج صنف إضافي ({activeProductItems.length}/5)
                  </button>
                </div>

                {combinedCandidateProducts.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {combinedCandidateProducts.map((p) => {
                      const active = !excludedProductIds.includes(p.productId);
                      const isHero = active && activeProductItems[0]?.productId === p.productId;
                      return (
                        <div
                          key={p.productId}
                          className={`flex items-center gap-1.5 rounded-xl border bg-background p-1.5 transition ${
                            isHero
                              ? "border-primary ring-2 ring-primary/35"
                              : active
                                ? "border-primary/40"
                                : "border-border opacity-45"
                          }`}
                        >
                          <div className="size-9 shrink-0 overflow-hidden rounded-lg border border-border bg-white p-0.5">
                            {p.imageUrl ? (
                              <img src={p.imageUrl} alt={p.name} className="size-full object-contain" />
                            ) : (
                              <span className="flex size-full items-center justify-center text-[9px] font-bold">#</span>
                            )}
                          </div>
                          <div className="max-w-[115px] min-w-0">
                            <div className="truncate text-[11px] font-bold text-foreground">{p.name}</div>
                            <div className="flex items-center gap-1 pt-0.5">
                              <button
                                type="button"
                                onClick={() => promoteProductToHero(p.productId)}
                                title="ترقية كمنتج بطل في صدارة المنتصف"
                                className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold transition ${
                                  isHero
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted text-muted-foreground hover:text-foreground"
                                }`}
                              >
                                <Crown aria-hidden className="size-2.5" />
                                {isHero ? "البطل" : "اجعله البطل"}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setExcludedProductIds((prev) =>
                                    prev.includes(p.productId)
                                      ? prev.filter((id) => id !== p.productId)
                                      : [...prev, p.productId],
                                  )
                                }
                                aria-label={active ? `إخفاء ${p.name}` : `إظهار ${p.name}`}
                                title={active ? "إخفاء من البنر" : "إظهار في البنر"}
                                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                              >
                                {active ? <Eye aria-hidden className="size-3" /> : <EyeOff aria-hidden className="size-3" />}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {showAddProductPicker && (
                  <div className="space-y-2 rounded-lg border border-border bg-background p-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={extraSearchQuery}
                        onChange={(e) => setExtraSearchQuery(e.target.value)}
                        placeholder="ابحث عن منتج متوفر لدمجه مع المجموعة في البنر…"
                        className="h-8 flex-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => setShowAddProductPicker(false)}
                        className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                      >
                        إغلاق
                      </button>
                    </div>
                    <div className="grid max-h-36 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                      {(extraProductsQ.data ?? []).map((cand) => {
                        const alreadyIn = activeProductItems.some((a) => a.productId === cand.productId);
                        return (
                          <button
                            key={cand.productId}
                            type="button"
                            disabled={alreadyIn || activeProductItems.length >= 5}
                            onClick={() => addExtraProductToEnsemble(cand)}
                            className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-1.5 text-right text-[11px] transition hover:bg-accent disabled:opacity-45"
                          >
                            <div className="size-8 shrink-0 overflow-hidden rounded border border-border bg-white p-0.5">
                              {cand.imageUrl && <img src={cand.imageUrl} alt="" className="size-full object-contain" />}
                            </div>
                            <span className="flex-1 truncate font-semibold text-foreground">{cand.name}</span>
                            <span className="shrink-0 text-[10px] font-bold text-primary">
                              {alreadyIn ? "مدمج" : "+ دمج"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* القسم 2: التدرج اللوني + الإضاءة + تكتيل المنتجات + الفعاليات التصميمية + النص */}
          {subject.mode !== "UPLOAD" ? (
            <section className="space-y-3.5 rounded-xl border border-border bg-muted/15 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-foreground">2. التدرج اللوني والإضاءة والفعاليات الإعلانية</span>
                <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-background p-0.5">
                  <button
                    type="button"
                    onClick={() => setVisualMode("LOCAL_STUDIO")}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition ${
                      visualMode === "LOCAL_STUDIO"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    استوديو متعدّد الطبقات (فوري)
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisualMode("HYBRID_STAGE")}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition ${
                      visualMode !== "LOCAL_STUDIO"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    مشهد سينمائي هجين (حفظ المنتج 100%)
                  </button>
                </div>
              </div>

              {/* 10 لوحات تدرج لوني بمستوى الوكالات العالمية */}
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {BANNER_STUDIO_PRESET_IDS.map((id) => {
                  const p = BANNER_STUDIO_PRESETS[id];
                  const selected = presetId === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setPresetId(id);
                        setPresetLockedByUser(true);
                      }}
                      title={p.descriptionAr}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-right text-xs transition ${
                        selected
                          ? "border-primary bg-primary/10 font-bold text-foreground ring-1 ring-primary/30"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="size-4 shrink-0 rounded-full border border-black/15"
                        style={{
                          background: `linear-gradient(135deg, ${p.palette.bgStart} 0%, ${p.palette.bgEnd} 58%, ${p.palette.accentHex} 100%)`,
                        }}
                      />
                      <span className="truncate">{p.labelAr}</span>
                    </button>
                  );
                })}
              </div>

              {/* ضبط الإضاءة + أسلوب دمج المنتجات + حجم الإبراز التسويقي + التأثيرات */}
              <div className="grid grid-cols-1 gap-2.5 rounded-xl border border-border bg-background p-2.5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <span className="flex items-center gap-1 text-[11px] font-bold text-foreground">
                    <Sun aria-hidden className="size-3.5 text-primary" />
                    ضبط الإضاءة الإعلانية
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {LIGHTING_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setLightingMode(opt.id)}
                        className={`rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                          lightingMode === opt.id
                            ? "border-primary bg-primary/15 font-bold text-primary"
                            : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {opt.labelAr}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="flex items-center gap-1 text-[11px] font-bold text-foreground">
                    <Layers aria-hidden className="size-3.5 text-primary" />
                    تكوين ودمج المنتجات ({activeProductItems.length})
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {COMPOSITION_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setCompositionStyle(opt.id)}
                        className={`rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                          compositionStyle === opt.id
                            ? "border-primary bg-primary/15 font-bold text-primary"
                            : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {opt.labelAr}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="flex items-center gap-1 text-[11px] font-bold text-foreground">
                    <Sparkles aria-hidden className="size-3.5 text-primary" />
                    فعاليات وتأثيرات الوكالات
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {EFFECT_OPTIONS.map((eff) => {
                      const active = effects.includes(eff.id);
                      return (
                        <button
                          key={eff.id}
                          type="button"
                          onClick={() => toggleCreativeEffect(eff.id)}
                          className={`rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {eff.labelAr}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="block text-[11px] font-bold text-foreground">حجم إبراز المنتجات تسويقياً</span>
                  <div className="flex flex-wrap gap-1">
                    {SCALE_OPTIONS.map((sc) => (
                      <button
                        key={sc.value}
                        type="button"
                        onClick={() => setProductScale(sc.value)}
                        className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition ${
                          Math.abs(productScale - sc.value) < 0.02
                            ? "border-primary bg-primary/15 font-bold text-primary"
                            : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {sc.labelAr}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* لوحة التصوير السينمائي عبر المزود المعتمد مع حراسة أمانة بكسلات المنتج */}
              {visualMode !== "LOCAL_STUDIO" && (
                <div className="space-y-2 rounded-xl border border-primary/30 bg-background p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="font-bold text-foreground">
                      وضع الحماية الموصى به: توليد بيئة ومنصة الإضاءة مع تركيب صور المنتجات الأصلية دون المساس ببكسلاتها أو كتابتها
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setVisualMode("HYBRID_STAGE")}
                        className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                          visualMode === "HYBRID_STAGE"
                            ? "bg-[var(--sem-pos)] text-background"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        هجين أمين 100%
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisualMode("AI_FULL_SCENE")}
                        className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                          visualMode === "AI_FULL_SCENE"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        مشهد مرجعي كامل
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={sceneHint}
                      onChange={(e) => setSceneHint(e.target.value)}
                      placeholder="توجيه بيئة وخامة المنصة فقط (مثلاً: رخام كحلي مصقول وإضاءة استوديو دافئة)…"
                      className="h-8 min-w-[200px] flex-1 text-xs"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        generateSceneM.mutate({
                          presetId,
                          placement: studioPlacement,
                          model: DEFAULT_BANNER_SCENE_MODEL,
                          productIds: activeProductItems.map((p) => p.productId).slice(0, 5),
                          customHint: sceneHint.trim() || null,
                          lightingMode,
                          sceneMode: visualMode === "AI_FULL_SCENE" ? "FULL_SCENE" : "STAGE_BACKDROP",
                        })
                      }
                      disabled={generateSceneM.isPending || !aiConfigQ.data?.aiAvailable}
                      className="h-8 gap-1.5 text-xs font-bold"
                    >
                      {generateSceneM.isPending ? (
                        <Loader2 aria-hidden className="size-3.5 animate-spin" />
                      ) : (
                        <Camera aria-hidden className="size-3.5" />
                      )}
                      {visualMode === "AI_FULL_SCENE"
                        ? "توليد المشهد بالمنتجات المرجعية"
                        : "توليد منصة الاستوديو السينمائية"}
                    </Button>
                  </div>
                  {!aiConfigQ.data?.aiAvailable && (
                    <span className="block text-[11px] text-muted-foreground">
                      استعمل «استوديو متعدّد الطبقات (فوري)» الجاهز حالياً أو فعّل مفتاح مزود الاستوديو في التكاملات.
                    </span>
                  )}
                </div>
              )}

              {variants.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-muted-foreground">زوايا الإقناع الموثّقة:</span>
                  {variants.map((v, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setCopy(v)}
                      className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
                        copy.headline === v.headline
                          ? "border-primary bg-primary/15 font-bold text-primary"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      {v.angleLabelAr || `صياغة ${idx + 1}`}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="text-xs font-medium text-muted-foreground sm:col-span-2">
                  العنوان الرئيسي على البنر (محروس بهوية المنتج/القسم)
                  <Input
                    value={copy.headline}
                    onChange={(e) => setCopy({ ...copy, headline: e.target.value })}
                    className="mt-1 h-9 text-xs font-bold text-foreground"
                  />
                </label>
                <label className="text-xs font-medium text-muted-foreground sm:col-span-2">
                  سطر القيمة والوصف المختصر
                  <Input
                    value={copy.subtitle}
                    onChange={(e) => setCopy({ ...copy, subtitle: e.target.value })}
                    className="mt-1 h-9 text-xs text-foreground"
                  />
                </label>
              </div>

              <details className="rounded-lg border border-border bg-background px-3 py-2 text-xs">
                <summary className="flex cursor-pointer list-none items-center justify-between font-semibold text-muted-foreground">
                  <span>تعديل الشارة العلوية أو السعر أو نص الزرّ (اختياري)</span>
                  <ChevronDown aria-hidden className="size-3.5" />
                </summary>
                <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <label className="text-[11px] text-muted-foreground">
                    الشارة العلوية
                    <Input
                      value={copy.eyebrow}
                      onChange={(e) => setCopy({ ...copy, eyebrow: e.target.value })}
                      className="mt-1 h-8 text-xs"
                    />
                  </label>
                  <label className="text-[11px] text-muted-foreground">
                    شارة السعر / الخصم
                    <Input
                      value={copy.priceBadge ?? ""}
                      onChange={(e) => setCopy({ ...copy, priceBadge: e.target.value || null })}
                      placeholder="تُسحب تلقائياً من السعر الفعلي"
                      className="mt-1 h-8 text-xs"
                    />
                  </label>
                  <label className="text-[11px] text-muted-foreground">
                    نصّ الزرّ داخل البنر
                    <Input
                      value={copy.ctaLabel}
                      onChange={(e) => setCopy({ ...copy, ctaLabel: e.target.value })}
                      className="mt-1 h-8 text-xs"
                    />
                  </label>
                </div>
              </details>

              {/* درع حراسة ملامح المنتج وأمانة النصوص والأرقام */}
              <div
                className={`space-y-1.5 rounded-xl border p-2.5 text-[11px] ${
                  copyCheck.ok
                    ? "border-[var(--sem-pos)]/35 bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                    : "border-[var(--sem-neg)]/45 bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-bold">
                    {copyCheck.ok ? (
                      <ShieldCheck aria-hidden className="size-4 shrink-0" />
                    ) : (
                      <ShieldAlert aria-hidden className="size-4 shrink-0" />
                    )}
                    {copyCheck.ok
                      ? "حارس أمانة المنتج والنص: ملامح المنتجات وكتابة الأغلفة والأسعار محروسة 100%"
                      : "تنبيه حارس أمانة المنتج والنص (تم تعليق النشر مؤقتاً لحين التصحيح):"}
                  </span>
                  {!copyCheck.ok && (
                    <button
                      type="button"
                      onClick={restoreVerifiedCopy}
                      className="inline-flex items-center gap-1 rounded-lg border border-current bg-background px-2 py-0.5 text-[11px] font-bold hover:opacity-90"
                    >
                      <RotateCcw aria-hidden className="size-3" />
                      استعادة الصياغة الموثّقة
                    </button>
                  )}
                </div>
                {!copyCheck.ok ? (
                  <ul className="list-inside list-disc space-y-0.5 font-semibold">
                    {copyCheck.issues.map((iss, idx) => (
                      <li key={idx}>{iss}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-[11px] opacity-90">
                    {composed?.quality.pixelFidelityGuaranteed !== false
                      ? "البكسلات الأصلية لصور المنتجات مركّبة مباشرةً بلا إعادة رسم أو هلوسة · كل الأرقام مطابقة للبيانات الفعلية."
                      : "المشهد المرجعي محكوم بـ BANNER_PRODUCT_FIDELITY_GUARD (ولقفل بكسلات الأغلفة 100% اختر «هجين أمين 100%»)."}
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="space-y-3 rounded-xl border border-border bg-muted/15 p-3">
              <span className="block text-xs font-bold text-foreground">2. صورة البنر الجاهزة والعنوان</span>
              <label className="block text-xs font-medium text-muted-foreground">
                الاسم التوضيحي للبنر *
                <Input
                  value={copy.headline}
                  onChange={(e) => setCopy({ ...copy, headline: e.target.value })}
                  className="mt-1 h-9 text-xs font-bold text-foreground"
                />
              </label>
              <ImageUploader
                value={uploadedDesktop}
                onChange={setUploadedDesktop}
                maxItems={20}
                singlePrimary={false}
                hint="ارفع صورة سطح المكتب (1600×640 للرئيسي أو 1500×500 للفاصل) — يحفظ الروابط الفردية للشرائح القائمة."
              />
              {uploadedDesktop.length <= 1 && (
                <ImageUploader
                  value={uploadedMobile}
                  onChange={setUploadedMobile}
                  maxItems={1}
                  singlePrimary={false}
                  hint="نسخة الهاتف الاختيارية (1200×600)."
                />
              )}
            </section>
          )}

          {/* القسم 3: موضع الظهور والجدولة */}
          <section className="space-y-2.5 rounded-xl border border-border bg-muted/15 p-3">
            <span className="block text-xs font-bold text-foreground">3. أين يظهر البنر في المتجر؟</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setPlacement("HERO")}
                className={`rounded-xl border p-2.5 text-right transition ${placement === "HERO" ? "border-primary bg-primary/10 font-bold" : "border-border bg-background hover:bg-accent"}`}
              >
                <div className="text-xs font-bold">أعلى المتجر — البنر الرئيسي</div>
                <div className="text-[11px] text-muted-foreground">يظهر أيضاً كبنر سياقي أعلى الفئة المستهدفة</div>
              </button>
              <button
                type="button"
                onClick={() => setPlacement("INLINE")}
                className={`rounded-xl border p-2.5 text-right transition ${placement === "INLINE" ? "border-primary bg-primary/10 font-bold" : "border-border bg-background hover:bg-accent"}`}
              >
                <div className="text-xs font-bold">بين صفوف المنتجات — شريط فاصل</div>
                <div className="text-[11px] text-muted-foreground">يفصل بين الأقسام أثناء التصفح</div>
              </button>
            </div>

            <details className="rounded-lg border border-border bg-background px-3 py-2 text-xs">
              <summary className="flex cursor-pointer list-none items-center justify-between font-semibold text-muted-foreground">
                <span>خيارات متقدمة اختيارية (جدولة تاريخ الظهور والترتيب)</span>
                <ChevronDown aria-hidden className="size-3.5" />
              </summary>
              <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="text-[11px] text-muted-foreground">
                  يبدأ في
                  <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="mt-1 h-8 text-xs" />
                </label>
                <label className="text-[11px] text-muted-foreground">
                  ينتهي في (يُسحب تلقائياً من العرض)
                  <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} className="mt-1 h-8 text-xs" />
                </label>
                <label className="text-[11px] text-muted-foreground">
                  أولوية الترتيب
                  <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="mt-1 h-8 text-xs" />
                </label>
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs font-medium">
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="size-4" />
                نشر البنر مفعّلاً في المتجر فور الحفظ
              </label>
            </details>
          </section>
        </div>

        {/* العمود الأيسر: المعاينة الحية + شريط تجميع شرائح الحملة + النشر */}
        <div className="lg:col-span-5">
          <div className="sticky top-4 space-y-3 rounded-2xl border border-border bg-muted/20 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-bold">
                <Eye aria-hidden className="size-4 text-primary" />
                المعاينة الحية
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setPreviewViewport("DESKTOP")}
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                    previewViewport === "DESKTOP"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-background text-muted-foreground"
                  }`}
                >
                  <Laptop aria-hidden className="size-3.5" /> سطح المكتب
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewViewport("MOBILE")}
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                    previewViewport === "MOBILE"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-background text-muted-foreground"
                  }`}
                >
                  <Smartphone aria-hidden className="size-3.5" /> الهاتف
                </button>
              </div>
            </div>

            <div className="relative flex min-h-[195px] items-center justify-center overflow-hidden rounded-xl border border-border bg-background p-2">
              {subject.mode === "UPLOAD" ? (
                (previewViewport === "MOBILE" && (uploadedMobile[0]?.dataUrl ?? uploadedMobile[0]?.url)) ||
                uploadedDesktop[0]?.dataUrl ||
                uploadedDesktop[0]?.url ? (
                  <img
                    src={
                      (previewViewport === "MOBILE" ? (uploadedMobile[0]?.dataUrl ?? uploadedMobile[0]?.url) : null) ??
                      uploadedDesktop[0]?.dataUrl ??
                      uploadedDesktop[0]?.url
                    }
                    alt={copy.headline}
                    className="w-full rounded-lg object-contain"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">ارفع صورة البنر لمعاينتها هنا</span>
                )
              ) : composed ? (
                <>
                  {composing && (
                    <span className="absolute right-2.5 top-2.5 rounded-full bg-background/90 px-2 py-0.5 text-[10px] font-bold shadow">
                      تحديث…
                    </span>
                  )}
                  <img
                    src={previewViewport === "DESKTOP" ? composed.desktopDataUrl : composed.mobileDataUrl}
                    alt={copy.headline}
                    className={`rounded-lg object-contain shadow-xs ${previewViewport === "MOBILE" ? "max-w-[320px] w-full" : "w-full"}`}
                  />
                </>
              ) : (
                <Loader2 aria-hidden className="size-6 animate-spin text-muted-foreground" />
              )}
            </div>

            {subject.mode !== "UPLOAD" && composed && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                  <CheckCircle2 aria-hidden className="size-3.5 text-[var(--sem-pos)]" />
                  تباين {composed.quality.contrastRatio}:1 · {composed.quality.mergedProductCount} أصناف مدمجة
                </span>
                <span className="font-semibold text-[var(--sem-pos)]">
                  {composed.quality.pixelFidelityGuaranteed ? "أصل المنتج محفوظ 100%" : "محروس بالمرجع"}
                </span>
                <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">
                  {subject.ctaUrl}
                </code>
              </div>
            )}

            {/* شريط شرائح الكاروسيل الاختياري لبناء حملة متعددة الشرائح بروابط مستقلة */}
            {subject.mode !== "UPLOAD" && (
              <div className="space-y-2 rounded-xl border border-dashed border-border bg-background/70 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    {campaignSlides.length > 0
                      ? `شرائح الحملة المجمّعة (${campaignSlides.length})`
                      : "هل تريد جمع عدة شرائح في كاروسيل واحد؟"}
                  </span>
                  <button
                    type="button"
                    onClick={stageCurrentSlideIntoTray}
                    disabled={!composed || !copyCheck.ok}
                    className="inline-flex items-center gap-1 rounded-lg border border-primary/35 bg-primary/10 px-2 py-1 text-[11px] font-bold text-primary transition hover:bg-primary/20 disabled:opacity-50"
                  >
                    <Plus aria-hidden className="size-3" />
                    تثبيت كشريحة وإضافة أخرى
                  </button>
                </div>
                {campaignSlides.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {campaignSlides.map((slide, idx) => (
                      <div
                        key={idx}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-[11px]"
                      >
                        <img src={slide.url} alt="" className="h-5 w-10 rounded object-cover" />
                        <span className="max-w-[110px] truncate font-semibold">{slide.title || `شريحة ${idx + 1}`}</span>
                        <button
                          type="button"
                          onClick={() => setCampaignSlides((prev) => prev.filter((_, i) => i !== idx))}
                          aria-label="إزالة الشريحة"
                          className="text-[var(--sem-neg)] hover:opacity-80"
                        >
                          <Trash2 aria-hidden className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                onClick={handlePublish}
                disabled={
                  saving ||
                  (subject.mode !== "UPLOAD" && (!copyCheck.ok || (!composed && campaignSlides.length === 0)))
                }
                className="flex-1 gap-2 font-bold"
              >
                {saving ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Save aria-hidden className="size-4" />}
                {editingBanner
                  ? "حفظ تعديلات البنر"
                  : campaignSlides.length > 0
                    ? `نشر الكاروسيل (${campaignSlides.length + 1} شرائح)`
                    : "نشر البنر في المتجر الآن"}
              </Button>
              <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
                إلغاء
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
