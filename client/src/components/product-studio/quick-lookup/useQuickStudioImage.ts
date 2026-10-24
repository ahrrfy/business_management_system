import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { notify } from "@/lib/notify";
import { normalizeAiStudioImage } from "@/lib/imageStudio/aiStudio";
import {
  finishCutFromCutout,
  runFreeStudioFlatten,
} from "@/lib/imageStudio/freePipeline";
import { prepareMobileCapturedImage } from "./prepareMobileCapturedImage";
import type { StudioMode } from "./types";

interface Options {
  aiAvailable: boolean;
  proAvailable: boolean;
  productId?: number;
  barcode?: string;
}

export function useQuickStudioImage({
  aiAvailable,
  proAvailable,
  productId,
  barcode,
}: Options) {
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [processedImage, setProcessedImage] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<StudioMode>("FLATTEN");
  const [isProcessingAi, setIsProcessingAi] = useState(false);
  const processedCacheRef = useRef<Partial<Record<StudioMode, string>>>({});
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const processingRef = useRef(false);
  const quickAiMutation = trpc.productStudio.quickAiTransform.useMutation();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const getGeneration = useCallback(() => generationRef.current, []);
  const isProcessing = useCallback(() => processingRef.current, []);
  const isCurrent = useCallback(
    (generation: number) =>
      mountedRef.current && generation === generationRef.current,
    [],
  );
  const setProcessing = (busy: boolean) => {
    processingRef.current = busy;
    setIsProcessingAi(busy);
  };
  const resetImageState = useCallback(() => {
    generationRef.current += 1;
    processedCacheRef.current = {};
    processingRef.current = false;
    setRawImage(null);
    setProcessedImage(null);
    setIsProcessingAi(false);
  }, []);

  const processImageInMode = async (
    sourceDataUrl: string,
    mode: StudioMode,
    generation: number,
  ) => {
    if (!isCurrent(generation)) return;
    if (processedCacheRef.current[mode]) {
      setProcessedImage(processedCacheRef.current[mode]!);
      setProcessing(false);
      return;
    }
    setProcessing(true);
    try {
      if (mode === "ORIGINAL") {
        processedCacheRef.current.ORIGINAL = sourceDataUrl;
        setProcessedImage(sourceDataUrl);
      } else if (mode === "FLATTEN") {
        const result = await runFreeStudioFlatten(sourceDataUrl);
        if (!isCurrent(generation)) return;
        processedCacheRef.current.FLATTEN = result.dataUrl;
        setProcessedImage(result.dataUrl);
      } else {
        try {
          const res = await quickAiMutation.mutateAsync({
            imageDataUrl: sourceDataUrl,
            mode,
            productId,
            barcode,
          });
          if (!isCurrent(generation)) return;
          const result =
            mode === "REMOVEBG"
              ? await finishCutFromCutout(res.imageDataUrl, sourceDataUrl, {
                  trustCutout: true,
                })
              : await normalizeAiStudioImage(res.imageDataUrl);
          if (!isCurrent(generation)) return;
          processedCacheRef.current[mode] = result.dataUrl;
          setProcessedImage(result.dataUrl);
        } catch (err: any) {
          if (!isCurrent(generation)) return;
          notify.warn(
            err.message ||
              (mode === "REMOVEBG"
                ? "تعذر العزل عبر remove.bg، تم التحويل للخلفية البيضاء السريعة."
                : "تعذر تحسين الصورة باستوديو الذكاء (API)، تم التحويل للخلفية البيضاء السريعة."),
          );
          const fallback = await runFreeStudioFlatten(sourceDataUrl);
          if (!isCurrent(generation)) return;
          processedCacheRef.current.FLATTEN = fallback.dataUrl;
          setActiveMode("FLATTEN");
          setProcessedImage(fallback.dataUrl);
        }
      }
    } catch (err: any) {
      if (!isCurrent(generation)) return;
      notify.err(err.message || "تعذر تطبيق معالجة الاستوديو");
      setProcessedImage(sourceDataUrl);
    } finally {
      if (isCurrent(generation)) setProcessing(false);
    }
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    input.value = "";
    const generation = ++generationRef.current;
    processedCacheRef.current = {};
    setRawImage(null);
    setProcessedImage(null);
    setProcessing(true);
    try {
      const optimizedDataUrl = await prepareMobileCapturedImage(file);
      if (!isCurrent(generation)) return;
      setRawImage(optimizedDataUrl);
      const initialMode: StudioMode = aiAvailable
        ? "AI"
        : proAvailable
          ? "REMOVEBG"
          : "FLATTEN";
      setActiveMode(initialMode);
      await processImageInMode(optimizedDataUrl, initialMode, generation);
    } catch (err: any) {
      if (isCurrent(generation)) notify.err(err.message || "تعذر تجهيز الصورة");
    } finally {
      if (isCurrent(generation)) setProcessing(false);
    }
  };

  const handleModeChange = async (newMode: StudioMode) => {
    if (!rawImage || processingRef.current) return;
    const generation = ++generationRef.current;
    setActiveMode(newMode);
    await processImageInMode(rawImage, newMode, generation);
  };

  return {
    rawImage,
    processedImage,
    activeMode,
    isProcessingAi,
    resetImageState,
    handleFileChange,
    handleModeChange,
    getGeneration,
    isCurrent,
    isProcessing,
  };
}
