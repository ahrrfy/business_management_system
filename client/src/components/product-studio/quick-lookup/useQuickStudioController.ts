import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { createProductDisplayThumbnail } from "@/lib/productImageThumbnail";
import { useQuickStudioAvailability } from "./useQuickStudioAvailability";
import { useQuickStudioImage } from "./useQuickStudioImage";
import type { GalleryImageReplaceTarget } from "../ProductImageGallery";
import type {
  QuickStudioProps,
  QuickStudioSaveInput,
  QuickStudioTarget,
} from "./types";

export function useQuickStudioController({
  offline = false,
  externalTarget = null,
  onExternalTargetClose,
  externalScannerOpen,
  onExternalScannerOpenChange,
  onProductHandled,
}: QuickStudioProps) {
  const utils = trpc.useUtils();
  const availability = useQuickStudioAvailability(offline);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [internalScannerOpen, setInternalScannerOpen] = useState(false);
  const [lookupTarget, setLookupTarget] = useState<QuickStudioTarget | null>(
    null,
  );
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [saveForVariantOnly, setSaveForVariantOnly] = useState(true);
  const [setAsPrimary, setSetAsPrimary] = useState(true);
  const [replaceTarget, setReplaceTarget] = useState<GalleryImageReplaceTarget | null>(null);
  const [previewZoomImage, setPreviewZoomImage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasLookupInput = Boolean(
    lookupTarget &&
    (lookupTarget.barcode?.trim() ||
      (lookupTarget.productId != null && Number(lookupTarget.productId) > 0)),
  );
  const lookupQuery = trpc.productStudio.quickBarcodeLookup.useQuery(
    {
      barcode: lookupTarget?.barcode?.trim() || undefined,
      productId: lookupTarget?.productId ?? undefined,
      variantId: lookupTarget?.variantId ?? undefined,
    },
    { enabled: hasLookupInput && !offline, retry: false },
  );
  const product = lookupQuery.data?.product;
  const activeBarcodeBadge =
    lookupTarget?.barcode?.trim() || product?.barcode?.trim() || null;
  const image = useQuickStudioImage({
    ...availability,
    productId: product?.id,
    barcode: activeBarcodeBadge || undefined,
  });
  const { resetImageState } = image;
  const saveMutation =
    trpc.productStudio.quickSaveBarcodeProductImage.useMutation();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!externalTarget) return;
    const hasValidTarget =
      Boolean(externalTarget.barcode?.trim()) ||
      (externalTarget.productId != null &&
        Number(externalTarget.productId) > 0);
    if (!hasValidTarget || offline) return;
    resetImageState();
    setLookupTarget({
      barcode: externalTarget.barcode?.trim() || undefined,
      productId: externalTarget.productId ?? undefined,
      variantId: externalTarget.variantId ?? null,
    });
    setSaveForVariantOnly(externalTarget.variantId != null);
    setProductModalOpen(true);
  }, [externalTarget, offline, resetImageState]);

  const setCameraScannerOpen = (open: boolean) => {
    setInternalScannerOpen(open);
    onExternalScannerOpenChange?.(open);
  };
  const handleStartSearch = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed || offline) return;
    resetImageState();
    setLookupTarget({ barcode: trimmed });
    setSaveForVariantOnly(true);
    setProductModalOpen(true);
  };
  const handleCameraDetect = (detected: string) => {
    setCameraScannerOpen(false);
    setBarcodeInput(detected);
    handleStartSearch(detected);
  };
  const closeModal = () => {
    resetImageState();
    setReplaceTarget(null);
    setProductModalOpen(false);
    setLookupTarget(null);
    onExternalTargetClose?.();
  };
  const startReplaceImage = (img: GalleryImageReplaceTarget) => {
    resetImageState();
    setReplaceTarget(img);
    setSaveForVariantOnly(img.variantId != null);
    if (img.isPrimary) setSetAsPrimary(true);
    fileInputRef.current?.click();
  };
  const clearReplaceTarget = () => {
    setReplaceTarget(null);
  };

  const handleSubmitImage = async () => {
    if (
      savingRef.current ||
      image.isProcessing() ||
      !image.processedImage ||
      !product?.id ||
      !availability.canQuickSave
    )
      return;
    savingRef.current = true;
    setIsSaving(true);
    const generation = image.getGeneration();
    const resolvedVariantId = replaceTarget
      ? replaceTarget.variantId
      : product.variantId != null && saveForVariantOnly
        ? product.variantId
        : null;
    const snapshot: Omit<QuickStudioSaveInput, "thumbnailDataUrl"> = {
      productId: product.id,
      variantId: resolvedVariantId,
      barcode: activeBarcodeBadge || undefined,
      originalDataUrl: image.rawImage,
      processedDataUrl: image.processedImage,
      mode: image.activeMode === "REMOVEBG" ? "PRO" : image.activeMode,
      setAsPrimary,
      ...(replaceTarget ? { replaceImageId: replaceTarget.id } : {}),
    };
    try {
      const thumbnailDataUrl = await createProductDisplayThumbnail(
        snapshot.processedDataUrl,
      );
      if (!image.isCurrent(generation)) return;
      const data = await saveMutation.mutateAsync({
        ...snapshot,
        thumbnailDataUrl,
      });
      void utils.productStudio?.invalidate?.();
      void utils.catalog?.adminList?.invalidate?.();
      void utils.catalog?.posList?.invalidate?.();
      void utils.catalog?.getForVariantEdit?.invalidate?.({ productId: snapshot.productId });
      void utils.storeAdmin?.catalog?.list?.invalidate?.();
      if (!mountedRef.current) return;
      notify.ok(data.message);
      setReplaceTarget(null);
      onProductHandled?.(snapshot.productId);
      if (image.isCurrent(generation)) {
        void lookupQuery.refetch();
        resetImageState();
      }
    } catch (err: any) {
      if (image.isCurrent(generation))
        notify.err(err.message || "تعذر تجهيز المصغرة وإرسال الصورة");
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setIsSaving(false);
    }
  };

  return {
    ...availability,
    ...image,
    offline,
    barcodeInput,
    setBarcodeInput,
    lookupTarget,
    productModalOpen,
    saveForVariantOnly,
    setSaveForVariantOnly,
    setAsPrimary,
    setSetAsPrimary,
    replaceTarget,
    startReplaceImage,
    clearReplaceTarget,
    previewZoomImage,
    setPreviewZoomImage,
    isSaving,
    cameraInputRef,
    fileInputRef,
    searchInputRef,
    lookupQuery,
    product,
    existingImages: lookupQuery.data?.images ?? [],
    canAutoApprove: lookupQuery.data?.canAutoApprove === true,
    activeBarcodeBadge,
    cameraScannerOpen: Boolean(externalScannerOpen) || internalScannerOpen,
    setCameraScannerOpen,
    handleStartSearch,
    handleCameraDetect,
    closeModal,
    handleSubmitImage,
  };
}

export type QuickStudioController = ReturnType<typeof useQuickStudioController>;
