import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Minus, Plus } from "lucide-react";
import {
  adjustStudioReviewZoom,
  type StudioReviewImage,
} from "@/lib/productStudio/mobileStudioUi";
import type { RouterOutputs } from "@/lib/trpc";

export function StudioPreviewPair({
  data,
}: {
  data: RouterOutputs["productStudio"]["candidatePreview"];
}) {
  const [mobileImage, setMobileImage] = useState<StudioReviewImage>("candidate");
  const [zoom, setZoom] = useState(1);
  const urls = useMemo(() => {
    function make(base64: string, mime: string): string {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    }
    return {
      original: make(data.originalBase64, data.originalMime),
      processed: make(data.processedBase64, data.processedMime),
    };
  }, [data]);
  useEffect(
    () => () => {
      URL.revokeObjectURL(urls.original);
      URL.revokeObjectURL(urls.processed);
    },
    [urls],
  );
  return (
    <div className="space-y-3">
      <div className="sm:hidden">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="اختيار صورة المراجعة">
          <Button
            type="button"
            variant={mobileImage === "original" ? "default" : "outline"}
            className="min-h-11"
            onClick={() => setMobileImage("original")}
          >
            الصورة الأصلية
          </Button>
          <Button
            type="button"
            variant={mobileImage === "candidate" ? "default" : "outline"}
            className="min-h-11"
            onClick={() => setMobileImage("candidate")}
          >
            المرشّح
          </Button>
        </div>
        <figure className="mt-3 space-y-2 overflow-hidden rounded-md border p-2">
          <div className="flex min-h-11 items-center justify-between gap-2">
            <figcaption className="text-xs text-muted-foreground">
              {mobileImage === "original" ? "الأصل المحفوظ" : "المرشّح قبل النشر"}
            </figcaption>
            <div className="flex gap-1">
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-11"
                aria-label="تصغير الصورة"
                disabled={zoom <= 0.5}
                onClick={() => setZoom((current) => adjustStudioReviewZoom(current, "out"))}
              >
                <Minus aria-hidden className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-11"
                aria-label="تكبير الصورة"
                disabled={zoom >= 3}
                onClick={() => setZoom((current) => adjustStudioReviewZoom(current, "in"))}
              >
                <Plus aria-hidden className="size-4" />
              </Button>
            </div>
          </div>
          <img
            src={mobileImage === "original" ? urls.original : urls.processed}
            alt={mobileImage === "original" ? "الصورة الأصلية" : "الصورة المرشحة"}
            className="mx-auto aspect-square max-h-80 w-full object-contain transition-transform"
            style={{ transform: `scale(${zoom})` }}
          />
        </figure>
      </div>
      <div className="hidden gap-3 sm:grid sm:grid-cols-2">
        <figure className="space-y-1 rounded-md border p-2">
          <img
            src={urls.original}
            alt="الصورة الأصلية"
            className="mx-auto aspect-square max-h-72 w-full object-contain"
          />
          <figcaption className="text-center text-xs text-muted-foreground">
            الأصل المحفوظ
          </figcaption>
        </figure>
        <figure className="space-y-1 rounded-md border p-2">
          <img
            src={urls.processed}
            alt="الصورة المرشحة"
            className="mx-auto aspect-square max-h-72 w-full object-contain"
          />
          <figcaption className="text-center text-xs text-muted-foreground">
            المرشّح قبل النشر
          </figcaption>
        </figure>
      </div>
    </div>
  );
}
