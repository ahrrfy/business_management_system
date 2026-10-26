import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
} from "react";
import {
  Image as ImageIcon,
  Download,
  Sparkles,
  RefreshCw,
  Eye,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  MAX_CUSTOMIZATION_ASSET_BYTES,
  estimateBase64ByteLength,
  exportStudioCanvasPayload,
  formatCustomizationUploadError,
  loadStudioImage,
  readFileAsDataUrl,
  stripDataUrlBase64,
  validateCustomizationAssetFile,
  validateCustomizationImageDimensions,
  type CustomizationAssetMime,
  type CustomizationStudioUploadState,
} from "./storefrontCustomizationUpload";

export interface StorefrontCustomizerStudioHandle {
  invalidateSavedPreview: (syncPrimaryText?: string) => void;
}

interface StorefrontCustomizerStudioProps {
  productName: string;
  baseImageUrl?: string | null;
  studioRef?: React.Ref<StorefrontCustomizerStudioHandle>;
  onApplyCustomization?: (data: {
    customText: string;
    secondaryText?: string;
    fontFamily: string;
    textColor: string;
    hasLogo: boolean;
    logoFileName?: string;
    previewDataUrl?: string;
    logoAssetKey?: string;
    previewAssetKey?: string;
  }) => void;
  onAssetsChange?: (assets: {
    logoAssetKey?: string;
    previewAssetKey?: string;
  }) => void;
  onUploadStateChange?: (state: CustomizationStudioUploadState) => void;
  className?: string;
}

const ARABIC_FONTS = [
  { id: "cairo", name: "خط الرؤية المعاصر", css: "'Cairo', 'Segoe UI', Tahoma, sans-serif" },
  { id: "tajawal", name: "خط تجوال الأنيق", css: "'Tajawal', 'Segoe UI', Tahoma, sans-serif" },
  { id: "amiri", name: "خط أميري الكلاسيكي", css: "'Amiri', serif" },
  { id: "scheherazade", name: "خط النسخ الشريف", css: "'Scheherazade New', 'Amiri', serif" },
];

const PRESET_COLORS = [
  { id: "gold", name: "ذهبي ملكي", hex: "#D4AF37" },
  { id: "silver", name: "فضي مصقول", hex: "#E2E8F0" },
  { id: "black", name: "أسود داكن", hex: "#0F172A" },
  { id: "white", name: "أبيض ناصع", hex: "#FFFFFF" },
  { id: "navy", name: "كحلي فاخر", hex: "#1E3A8A" },
  { id: "emerald", name: "أخضر زمردي", hex: "#0E806A" },
];

type PendingLogoPayload = {
  fileName: string;
  mimeType: CustomizationAssetMime;
  dataBase64: string;
  dataUrl: string;
  uploadedAssetKey?: string;
};

export function StorefrontCustomizerStudio({
  productName,
  baseImageUrl,
  studioRef,
  onApplyCustomization,
  onAssetsChange,
  onUploadStateChange,
  className = "",
}: StorefrontCustomizerStudioProps) {
  const uploadAssetM = trpc.storefront.uploadCustomizationAsset.useMutation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mountedRef = useRef(true);
  const uploadEpochRef = useRef(0);
  const activeUploadKindRef = useRef<"LOGO" | "APPLY" | null>(null);
  const drawSeqRef = useRef(0);

  const [customText, setCustomText] = useState("");
  const [secondaryText, setSecondaryText] = useState("");
  const [selectedFont, setSelectedFont] = useState(ARABIC_FONTS[0].id);
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[0].hex);
  const [fontSize] = useState(36);
  const [verticalPosition] = useState(55);
  const [logoImage, setLogoImage] = useState<HTMLImageElement | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const [uploadState, setUploadState] =
    useState<CustomizationStudioUploadState>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<"LOGO" | "PREVIEW" | null>(
    null,
  );
  const pendingLogoRef = useRef<PendingLogoPayload | null>(null);
  const logoAssetKeyRef = useRef<string | undefined>(undefined);
  const previewAssetKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reportUploadState = useCallback(
    (next: CustomizationStudioUploadState) => {
      setUploadState(next);
      onUploadStateChange?.(next);
    },
    [onUploadStateChange],
  );

  const emitAssets = useCallback(
    (nextLogoKey?: string, nextPreviewKey?: string) => {
      logoAssetKeyRef.current = nextLogoKey || undefined;
      previewAssetKeyRef.current = nextPreviewKey || undefined;
      onAssetsChange?.({
        logoAssetKey: logoAssetKeyRef.current,
        previewAssetKey: previewAssetKeyRef.current,
      });
    },
    [onAssetsChange],
  );

  const invalidatePreviewIfStale = useCallback(() => {
    setApplied(false);
    if (activeUploadKindRef.current === "APPLY") {
      uploadEpochRef.current += 1;
      activeUploadKindRef.current = null;
      const validLogoKey = pendingLogoRef.current?.uploadedAssetKey;
      emitAssets(validLogoKey, undefined);
      if (pendingLogoRef.current && !validLogoKey) {
        setFailedAction("LOGO");
        setUploadError(
          "تعذّر رفع الشعار المحدد سابقاً. أعد المحاولة أو اضغط اعتماد التخصيص مجدداً.",
        );
        reportUploadState("error");
      } else {
        setUploadError(null);
        setFailedAction(null);
        reportUploadState(validLogoKey ? "uploaded" : "idle");
      }
      return;
    }
    if (previewAssetKeyRef.current) {
      emitAssets(logoAssetKeyRef.current, undefined);
      reportUploadState(logoAssetKeyRef.current ? "uploaded" : "idle");
    }
  }, [emitAssets, reportUploadState]);

  useImperativeHandle(
    studioRef,
    () => ({
      invalidateSavedPreview: (syncPrimaryText?: string) => {
        if (syncPrimaryText !== undefined) {
          setCustomText(syncPrimaryText);
        }
        invalidatePreviewIfStale();
      },
    }),
    [invalidatePreviewIfStale],
  );

  const paintStudioMockup = useCallback(
    (
      targetCanvas: HTMLCanvasElement,
      bgImg?: HTMLImageElement,
      overrideLogo?: HTMLImageElement | null,
    ) => {
      const ctx = targetCanvas.getContext("2d");
      if (!ctx) return;

      const width = 600;
      const height = 480;
      targetCanvas.width = width;
      targetCanvas.height = height;
      ctx.clearRect(0, 0, width, height);

      if (bgImg && bgImg.width > 0 && bgImg.height > 0) {
        const hRatio = width / bgImg.width;
        const vRatio = height / bgImg.height;
        const ratio = Math.min(hRatio, vRatio);
        const centerShiftX = (width - bgImg.width * ratio) / 2;
        const centerShiftY = (height - bgImg.height * ratio) / 2;
        ctx.fillStyle = "#F8FAFC";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(
          bgImg,
          0,
          0,
          bgImg.width,
          bgImg.height,
          centerShiftX,
          centerShiftY,
          bgImg.width * ratio,
          bgImg.height * ratio,
        );
      } else {
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, "#1E293B");
        gradient.addColorStop(0.5, "#0F172A");
        gradient.addColorStop(1, "#020617");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1;
        ctx.strokeRect(20, 20, width - 40, height - 40);

        ctx.strokeStyle = "rgba(212, 175, 55, 0.35)";
        ctx.lineWidth = 2;
        ctx.strokeRect(35, 35, width - 70, height - 70);

        ctx.font = "bold 14px 'Cairo', sans-serif";
        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        ctx.textAlign = "center";
        ctx.fillText(productName, width / 2, 60);
      }

      const posY = (height * verticalPosition) / 100;
      const activeLogo = overrideLogo !== undefined ? overrideLogo : logoImage;

      if (activeLogo && activeLogo.width > 0 && activeLogo.height > 0) {
        const logoMaxDim = 80;
        const logoScale = Math.min(
          logoMaxDim / activeLogo.width,
          logoMaxDim / activeLogo.height,
        );
        const logoW = activeLogo.width * logoScale;
        const logoH = activeLogo.height * logoScale;
        const logoX = width / 2 - logoW / 2;
        const logoY = posY - 70 - logoH / 2;

        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = 8;
        ctx.drawImage(activeLogo, logoX, logoY, logoW, logoH);
        ctx.restore();
      }

      const fontObj =
        ARABIC_FONTS.find((f) => f.id === selectedFont) ?? ARABIC_FONTS[0];

      if (customText.trim()) {
        ctx.save();
        ctx.font = `bold ${fontSize}px ${fontObj.css}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = selectedColor;
        ctx.fillText(customText.trim(), width / 2, posY);
        ctx.restore();
      } else {
        ctx.save();
        ctx.font = `italic 24px ${fontObj.css}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.fillText("اكتب اسمك أو عبارة التخصيص هنا للمعاينة", width / 2, posY);
        ctx.restore();
      }

      if (secondaryText.trim()) {
        ctx.save();
        ctx.font = `bold ${Math.round(fontSize * 0.55)}px ${fontObj.css}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
        ctx.shadowBlur = 4;
        ctx.fillStyle = selectedColor === "#FFFFFF" ? "#CBD5E1" : selectedColor;
        ctx.fillText(secondaryText.trim(), width / 2, posY + fontSize * 0.9);
        ctx.restore();
      }

      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
      ctx.fillText(
        "معاينة حية — استوديو الرؤية العربية",
        width - 25,
        height - 20,
      );
    },
    [
      customText,
      secondaryText,
      selectedFont,
      selectedColor,
      fontSize,
      verticalPosition,
      logoImage,
      productName,
    ],
  );

  const renderCanvasAsync = useCallback(
    async (overrideLogo?: HTMLImageElement | null) => {
      const seq = ++drawSeqRef.current;
      let bgImg: HTMLImageElement | undefined;
      if (baseImageUrl) {
        try {
          bgImg = await loadStudioImage(baseImageUrl, { crossOrigin: "anonymous" });
        } catch {
          bgImg = undefined;
        }
      }
      if (!mountedRef.current || seq !== drawSeqRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      paintStudioMockup(canvas, bgImg, overrideLogo);
    },
    [baseImageUrl, paintStudioMockup],
  );

  const redrawCanvas = useCallback(() => {
    void renderCanvasAsync();
  }, [renderCanvasAsync]);

  useEffect(() => {
    void renderCanvasAsync();
  }, [renderCanvasAsync]);

  const uploadLogoPayload = useCallback(
    async (
      payload: PendingLogoPayload,
      existingEpoch?: number,
    ): Promise<string | null> => {
      const epoch = existingEpoch ?? ++uploadEpochRef.current;
      activeUploadKindRef.current = "LOGO";
      setUploadError(null);
      setFailedAction(null);
      reportUploadState("uploading");
      try {
        const uploaded = await uploadAssetM.mutateAsync({
          kind: "LOGO",
          mimeType: payload.mimeType,
          dataBase64: payload.dataBase64,
        });
        if (!mountedRef.current || epoch !== uploadEpochRef.current) return null;
        if (pendingLogoRef.current === payload) {
          payload.uploadedAssetKey = uploaded.assetKey;
        }
        emitAssets(uploaded.assetKey, undefined);
        reportUploadState("uploaded");
        return uploaded.assetKey;
      } catch (error) {
        if (!mountedRef.current || epoch !== uploadEpochRef.current) return null;
        setFailedAction("LOGO");
        setUploadError(formatCustomizationUploadError(error));
        reportUploadState("error");
        return null;
      } finally {
        if (epoch === uploadEpochRef.current) {
          activeUploadKindRef.current = null;
        }
      }
    },
    [emitAssets, reportUploadState, uploadAssetM],
  );

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const epoch = ++uploadEpochRef.current;
    activeUploadKindRef.current = "LOGO";
    pendingLogoRef.current = null;
    setLogoImage(null);
    setLogoPreviewUrl(null);
    setApplied(false);
    emitAssets(undefined, undefined);

    const validation = validateCustomizationAssetFile(file);
    if (!validation.ok) {
      activeUploadKindRef.current = null;
      setFailedAction(null);
      setUploadError(validation.error);
      reportUploadState("error");
      return;
    }

    setUploadError(null);
    setFailedAction(null);
    reportUploadState("uploading");

    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (!mountedRef.current || epoch !== uploadEpochRef.current) return;

      const pureBase64 = stripDataUrlBase64(dataUrl);
      if (
        !pureBase64 ||
        estimateBase64ByteLength(pureBase64) > MAX_CUSTOMIZATION_ASSET_BYTES
      ) {
        activeUploadKindRef.current = null;
        setFailedAction(null);
        setUploadError(
          "حجم الصورة يتجاوز الحد الأقصى المسموح (2 ميجابايت). يرجى اختيار صورة أصغر.",
        );
        reportUploadState("error");
        return;
      }

      const loadedImg = await loadStudioImage(dataUrl);
      if (!mountedRef.current || epoch !== uploadEpochRef.current) return;

      const dimCheck = validateCustomizationImageDimensions(
        loadedImg.naturalWidth || loadedImg.width,
        loadedImg.naturalHeight || loadedImg.height,
      );
      if (!dimCheck.ok) {
        activeUploadKindRef.current = null;
        setFailedAction(null);
        setUploadError(dimCheck.error);
        reportUploadState("error");
        return;
      }

      setLogoImage(loadedImg);
      setLogoPreviewUrl(dataUrl);

      const payload: PendingLogoPayload = {
        fileName: file.name,
        mimeType: validation.mimeType,
        dataBase64: pureBase64,
        dataUrl,
      };
      pendingLogoRef.current = payload;
      await uploadLogoPayload(payload, epoch);
    } catch (error) {
      if (!mountedRef.current || epoch !== uploadEpochRef.current) return;
      activeUploadKindRef.current = null;
      setFailedAction(null);
      setUploadError(formatCustomizationUploadError(error));
      reportUploadState("error");
    }
  };

  const removeLogo = () => {
    uploadEpochRef.current += 1;
    activeUploadKindRef.current = null;
    pendingLogoRef.current = null;
    setLogoImage(null);
    setLogoPreviewUrl(null);
    setApplied(false);
    setUploadError(null);
    setFailedAction(null);
    emitAssets(undefined, undefined);
    reportUploadState("idle");
  };

  const buildUntaintedFallbackCanvas = useCallback(() => {
    const offscreen = document.createElement("canvas");
    paintStudioMockup(offscreen, undefined);
    return offscreen;
  }, [paintStudioMockup]);

  const downloadProof = async () => {
    await renderCanvasAsync();
    const exported = exportStudioCanvasPayload(
      canvasRef.current,
      buildUntaintedFallbackCanvas,
    );
    if (!exported.ok) return;
    const link = document.createElement("a");
    link.download = `proof-${productName.replace(/\s+/g, "_")}.png`;
    link.href = exported.dataUrl;
    link.click();
  };

  const handleApply = async () => {
    const epoch = ++uploadEpochRef.current;
    activeUploadKindRef.current = "APPLY";
    setUploadError(null);
    setFailedAction(null);
    reportUploadState("uploading");
    try {
      await renderCanvasAsync();
      if (!mountedRef.current || epoch !== uploadEpochRef.current) return;

      const exported = exportStudioCanvasPayload(
        canvasRef.current,
        buildUntaintedFallbackCanvas,
      );
      if (!exported.ok) {
        setFailedAction("PREVIEW");
        setUploadError(exported.error);
        reportUploadState("error");
        return;
      }

      const activeLogoPayload = pendingLogoRef.current;
      let currentLogoKey = activeLogoPayload
        ? activeLogoPayload.uploadedAssetKey
        : undefined;
      if (activeLogoPayload && !currentLogoKey) {
        const logoUploaded = await uploadAssetM.mutateAsync({
          kind: "LOGO",
          mimeType: activeLogoPayload.mimeType,
          dataBase64: activeLogoPayload.dataBase64,
        });
        if (!mountedRef.current || epoch !== uploadEpochRef.current) return;
        activeLogoPayload.uploadedAssetKey = logoUploaded.assetKey;
        currentLogoKey = logoUploaded.assetKey;
        emitAssets(currentLogoKey, undefined);
      }

      const previewUploaded = await uploadAssetM.mutateAsync({
        kind: "PREVIEW",
        mimeType: exported.mimeType,
        dataBase64: exported.dataBase64,
      });
      if (!mountedRef.current || epoch !== uploadEpochRef.current) return;

      emitAssets(currentLogoKey, previewUploaded.assetKey);
      reportUploadState("uploaded");
      onApplyCustomization?.({
        customText,
        secondaryText,
        fontFamily: selectedFont,
        textColor: selectedColor,
        hasLogo: Boolean(currentLogoKey || logoImage),
        logoFileName: activeLogoPayload?.fileName,
        previewDataUrl: exported.dataUrl,
        logoAssetKey: currentLogoKey,
        previewAssetKey: previewUploaded.assetKey,
      });
      setApplied(true);
      setTimeout(() => {
        if (mountedRef.current) setApplied(false);
      }, 3000);
    } catch (error) {
      if (!mountedRef.current || epoch !== uploadEpochRef.current) return;
      const pendingLogoMissingKey = Boolean(
        pendingLogoRef.current && !pendingLogoRef.current.uploadedAssetKey,
      );
      setFailedAction(pendingLogoMissingKey ? "LOGO" : "PREVIEW");
      setUploadError(formatCustomizationUploadError(error));
      reportUploadState("error");
    } finally {
      if (epoch === uploadEpochRef.current) {
        activeUploadKindRef.current = null;
      }
    }
  };

  const retryUpload = async () => {
    if (failedAction === "LOGO" && pendingLogoRef.current) {
      await uploadLogoPayload(pendingLogoRef.current);
      return;
    }
    if (failedAction === "PREVIEW") {
      await handleApply();
    }
  };

  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      <div className="mb-4 flex flex-col gap-1 border-b border-slate-100 pb-3 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400">
            <Sparkles className="size-4" />
          </div>
          <div>
            <h4 className="text-xs font-black text-slate-900 dark:text-slate-100">
              استوديو المعاينة الحية للطباعة والتخصيص
            </h4>
            <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
              شاهد اسمك وشعارك فورياً واحفظ المعاينة والشعار مباشرة مع طلبك
            </p>
          </div>
        </div>

        <Badge variant="outline" className="self-start text-[10px] font-black">
          حفظ مباشر مع الطلب
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="flex flex-col items-center justify-center lg:col-span-7">
          <div className="relative w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-950 shadow-inner dark:border-slate-800">
            <canvas
              ref={canvasRef}
              className="mx-auto block h-auto max-h-[360px] w-full object-contain"
            />
          </div>

          <div className="mt-3 flex w-full items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => void downloadProof()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <Download className="size-3.5" />
              <span>تنزيل بروفة التصميم (PNG)</span>
            </button>

            <button
              type="button"
              onClick={redrawCanvas}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              title="إعادة تحديث المعاينة"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3.5 text-right lg:col-span-5">
          <div>
            <Label
              htmlFor="custom-text-input"
              className="text-xs font-black text-slate-700 dark:text-slate-300"
            >
              نص التخصيص أو الاسم الرئيسي
            </Label>
            <Input
              id="custom-text-input"
              value={customText}
              onChange={(e) => {
                setCustomText(e.target.value);
                invalidatePreviewIfStale();
              }}
              placeholder="مثال: د. أحمد الهاشمي أو شركة الرؤية"
              maxLength={60}
              className="mt-1 text-xs font-bold"
            />
          </div>

          <div>
            <Label
              htmlFor="secondary-text-input"
              className="text-xs font-bold text-slate-600 dark:text-slate-400"
            >
              السطر الثانوي أو الصفة (اختياري)
            </Label>
            <Input
              id="secondary-text-input"
              value={secondaryText}
              onChange={(e) => {
                setSecondaryText(e.target.value);
                invalidatePreviewIfStale();
              }}
              placeholder="مثال: المدير التنفيذي / بغداد"
              maxLength={60}
              className="mt-1 text-xs"
            />
          </div>

          <div>
            <Label className="text-xs font-bold text-slate-700 dark:text-slate-300">
              نوع الخط العربي
            </Label>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {ARABIC_FONTS.map((font) => (
                <button
                  key={font.id}
                  type="button"
                  onClick={() => {
                    setSelectedFont(font.id);
                    invalidatePreviewIfStale();
                  }}
                  className={`rounded-lg border px-2 py-1.5 text-right text-[11px] font-black transition ${
                    selectedFont === font.id
                      ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/60 dark:text-blue-300"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {font.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label className="text-xs font-bold text-slate-700 dark:text-slate-300">
              لون الطباعة / النقش
            </Label>
            <div className="mt-1.5 flex items-center gap-2">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  onClick={() => {
                    setSelectedColor(color.hex);
                    invalidatePreviewIfStale();
                  }}
                  title={color.name}
                  aria-label={color.name}
                  className={`size-7 rounded-full border-2 transition ${
                    selectedColor === color.hex
                      ? "scale-110 ring-2 ring-blue-600 ring-offset-2"
                      : "hover:scale-105"
                  } ${color.id === "white" ? "border-slate-300" : "border-transparent"}`}
                  style={{ backgroundColor: color.hex }}
                />
              ))}
            </div>
          </div>

          <div>
            <Label className="text-xs font-bold text-slate-700 dark:text-slate-300">
              رفع شعار الشركة (PNG / JPEG / WebP حتى 2 ميجابايت)
            </Label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                <ImageIcon className="size-3.5" />
                <span>اختر ملف الشعار</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleLogoUpload}
                  disabled={uploadState === "uploading"}
                  className="sr-only"
                />
              </label>

              {(logoPreviewUrl ||
                uploadState === "error" ||
                (uploadState === "uploading" &&
                  activeUploadKindRef.current === "LOGO")) && (
                <button
                  type="button"
                  onClick={removeLogo}
                  disabled={
                    uploadState === "uploading" &&
                    activeUploadKindRef.current === "APPLY"
                  }
                  className="rounded-lg text-xs font-bold text-[var(--sem-neg)] hover:underline disabled:opacity-50"
                >
                  إزالة الشعار
                </button>
              )}
            </div>
          </div>

          <div className="mt-2 space-y-2.5 border-t border-slate-100 pt-3 dark:border-slate-800">
            {uploadState === "uploading" && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
              >
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span>جارٍ رفع وحفظ مرفقات التخصيص بأمان...</span>
              </div>
            )}

            {uploadState === "uploaded" && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-xl border border-[var(--sem-pos)]/30 bg-[var(--sem-pos-bg)] px-3 py-2 text-xs font-bold text-[var(--sem-pos)]"
              >
                <CheckCircle2 className="size-3.5 shrink-0" />
                <span>تم رفع وحفظ مرفقات التخصيص لربطها بالطلب</span>
              </div>
            )}

            {uploadState === "error" && uploadError && (
              <div
                role="alert"
                className="space-y-2 rounded-xl border border-[var(--sem-neg)]/30 bg-[var(--sem-neg-bg)] px-3 py-2.5 text-xs font-bold text-[var(--sem-neg)]"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <div className="space-y-0.5">
                    <div>{uploadError}</div>
                    <div className="text-[11px] font-semibold opacity-90">
                      المرفقات التي تعذّر رفعها لا ترسل مع الطلب حتى تعيد المحاولة أو تزيل الشعار.
                    </div>
                  </div>
                </div>
                {failedAction && (
                  <button
                    type="button"
                    onClick={retryUpload}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--sem-neg)]/40 bg-white px-2.5 py-1 text-[11px] font-black text-[var(--sem-neg)] hover:bg-slate-50"
                  >
                    <RotateCcw className="size-3" />
                    <span>إعادة المحاولة</span>
                  </button>
                )}
              </div>
            )}

            {uploadState === "idle" && (
              <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                اضغط «اعتماد التخصيص والمعاينة» لحفظ صورة المعاينة والشعار مباشرة مع طلبك.
              </p>
            )}

            <Button
              type="button"
              onClick={handleApply}
              disabled={uploadState === "uploading"}
              className="w-full gap-2 bg-blue-600 text-xs font-black text-white hover:bg-blue-700"
            >
              {uploadState === "uploading" ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span>جارٍ الحفظ والرفع...</span>
                </>
              ) : applied ? (
                <>
                  <CheckCircle2 className="size-4" />
                  <span>تم اعتماد وحفظ التخصيص في الطلب</span>
                </>
              ) : (
                <>
                  <Eye className="size-4" />
                  <span>اعتماد التخصيص والمعاينة</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
