import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { adjustStudioReviewZoom, type StudioReviewImage } from "@/lib/productStudio/mobileStudioUi";
import type { RouterOutputs } from "@/lib/trpc";

export interface StudioPreviewPairProps {
  data: RouterOutputs["productStudio"]["candidatePreview"];
}

export function StudioPreviewPair({ data }: StudioPreviewPairProps) {
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

  useEffect(() => () => {
    URL.revokeObjectURL(urls.original);
    URL.revokeObjectURL(urls.processed);
  }, [urls]);

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="space-y-4">
      {/* أدوات التحكم بالتكبير المشتركة لشاشات الديسك توب */}
      <div className="hidden sm:flex items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs">
        <span className="font-medium text-muted-foreground">
          معاينة المقارنة المباشرة — نسبة التكبير: {zoomPercent}%
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1 px-2.5 text-xs"
            aria-label="تصغير الصورة"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((current) => adjustStudioReviewZoom(current, "out"))}
          >
            <Minus aria-hidden className="size-3.5" />
            تصغير
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1 px-2.5 text-xs"
            aria-label="تكبير الصورة"
            disabled={zoom >= 3}
            onClick={() => setZoom((current) => adjustStudioReviewZoom(current, "in"))}
          >
            <Plus aria-hidden className="size-3.5" />
            تكبير
          </Button>
          {zoom !== 1 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              aria-label="إعادة ضبط التكبير"
              onClick={() => setZoom(1)}
            >
              <RotateCcw aria-hidden className="size-3.5" />
              إعادة ضبط
            </Button>
          )}
        </div>
      </div>

      {/* واجهة الهواتف (تبديل بين الصورتين) */}
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
            المرشّح المعالج
          </Button>
        </div>
        <figure className="mt-3 space-y-2 overflow-hidden rounded-md border p-2 bg-card">
          <div className="flex min-h-11 items-center justify-between gap-2">
            <figcaption className="text-xs font-medium text-muted-foreground">
              {mobileImage === "original" ? "الأصل المحفوظ" : "المرشّح قبل النشر"} ({zoomPercent}%)
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
          <div className="overflow-auto rounded bg-white p-2">
            <img
              src={mobileImage === "original" ? urls.original : urls.processed}
              alt={mobileImage === "original" ? "الصورة الأصلية" : "الصورة المرشحة"}
              className="mx-auto aspect-square max-h-[380px] w-full object-contain transition-transform duration-200 ease-out"
              style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
            />
          </div>
        </figure>
      </div>

      {/* واجهة الشاشات المتوسطة والديسك توب (عرض جنب إلى جنب مع تكبير متزامن) */}
      <div className="hidden gap-4 sm:grid sm:grid-cols-2">
        <figure className="space-y-2 rounded-lg border bg-card p-3 shadow-xs">
          <figcaption className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>الأصل المحفوظ</span>
            <span className="text-[11px] opacity-75">المصدر الأصلي</span>
          </figcaption>
          <div className="overflow-hidden rounded-md border border-border/50 bg-white p-2">
            <img
              src={urls.original}
              alt="الصورة الأصلية"
              className="mx-auto aspect-square max-h-[420px] w-full object-contain transition-transform duration-200 ease-out"
              style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
            />
          </div>
        </figure>

        <figure className="space-y-2 rounded-lg border bg-card p-3 shadow-xs">
          <figcaption className="flex items-center justify-between text-xs font-medium text-primary">
            <span>المرشّح قبل النشر</span>
            <span className="text-[11px] font-normal text-muted-foreground">قالب 90% + ألوان + ظل ناعم</span>
          </figcaption>
          <div className="overflow-hidden rounded-md border border-border/50 bg-white p-2">
            <img
              src={urls.processed}
              alt="الصورة المرشحة"
              className="mx-auto aspect-square max-h-[420px] w-full object-contain transition-transform duration-200 ease-out"
              style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
            />
          </div>
        </figure>
      </div>
    </div>
  );
}
