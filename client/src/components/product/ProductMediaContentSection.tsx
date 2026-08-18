import { ImageStudioUploader } from "@/components/product/ImageStudioUploader";
import type { ImageItem } from "@/components/form/ImageUploader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Images, Trash2 } from "lucide-react";
import { useRef } from "react";
import { Link } from "wouter";

interface Props {
  description: string;
  onDescriptionChange: (value: string) => void;
  images?: ImageItem[];
  onImagesChange?: (value: ImageItem[]) => void;
  marketingCopy?: string;
  onMarketingCopyChange?: (value: string) => void;
  maxImages?: number;
  title?: string;
  hint?: string;
  onOriginalCaptured?: (dataUrl: string) => void;
  onStudioModeChange?: (mode: "FLATTEN" | "CUT" | "AI") => void;
  studioTaskId?: number;
  onProcessingReceiptChange?: (receipt: string | null) => void;
  onStudioBusyChange?: (busy: boolean) => void;
  adminOverrideReason?: string;
  /** المنتج موجود في القاعدة ويمكن إنشاء مهمة له فوراً. */
  productExists?: boolean;
}

/** القسم الموحّد للصور والمحتوى في الإنشاء والتعديل ومركز الاستوديو. */
export function ProductMediaContentSection({
  description,
  onDescriptionChange,
  images = [],
  onImagesChange,
  marketingCopy,
  onMarketingCopyChange,
  maxImages = 10,
  title = "الصور والمحتوى",
  hint = "تُضغط الصور تلقائياً. استخدم زر الاستوديو لتوحيد الخلفية قبل الحفظ.",
  onOriginalCaptured,
  onStudioModeChange,
  studioTaskId,
  onProcessingReceiptChange,
  onStudioBusyChange,
  adminOverrideReason,
  productExists = false,
}: Props) {
  const capturedIds = useRef(new Set<string>());
  function handleImages(next: ImageItem[]) {
    // أي تعديل/رفع يدوي يبطل receipt سابقاً؛ اعتماد معاينة Pro/AI يعيده فوراً من المكوّن بعد onChange.
    onProcessingReceiptChange?.(null);
    if (onOriginalCaptured) {
      const fresh = next.find((item) => !capturedIds.current.has(item.id) && item.dataUrl);
      if (fresh) {
        capturedIds.current.add(fresh.id);
        onOriginalCaptured(fresh.dataUrl);
      }
    }
    onImagesChange?.(next);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {studioTaskId != null
            ? "هذه مهمة استوديو محكومة؛ المرشّح لا يظهر في المتجر قبل الاعتماد."
            : "هذه الشاشة لا تنشر بايتات الصور؛ تعرض الصور الحالية وتسمح بإزالتها فقط."}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="product-media-description">الوصف الواضح للمنتج</Label>
          <Textarea
            id="product-media-description"
            rows={3}
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            maxLength={5_000}
            placeholder="المواصفات، الاستخدام، وما يحتاج الزبون معرفته قبل الشراء"
          />
        </div>
        {onMarketingCopyChange && (
          <div className="space-y-1.5">
            <Label htmlFor="product-media-marketing">النص الترويجي</Label>
            <Textarea
              id="product-media-marketing"
              rows={2}
              value={marketingCopy ?? ""}
              onChange={(event) => onMarketingCopyChange(event.target.value)}
              maxLength={3_000}
              placeholder="فائدة مختصرة وصادقة تساعد الزبون على الاختيار"
            />
          </div>
        )}
        {studioTaskId != null ? (
          <ImageStudioUploader value={images} onChange={handleImages} maxItems={maxImages} hint={hint} onStudioModeChange={onStudioModeChange} studioTaskId={studioTaskId} onProcessingReceiptChange={onProcessingReceiptChange} onBusyChange={onStudioBusyChange} adminOverrideReason={adminOverrideReason} />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="font-medium">إضافة الصور واستبدالها تتم عبر استوديو صور المنتجات.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {productExists ? "افتح الاستوديو وأنشئ مهمة مراجعة لهذا المنتج." : "احفظ المنتج أولاً، ثم افتح الاستوديو وأنشئ مهمة مراجعة له."}
                </p>
              </div>
              <Button asChild type="button" variant="outline" className="w-full shrink-0 sm:w-auto">
                <Link href="/catalog/image-studio"><Images aria-hidden className="size-4" /> فتح استوديو الصور</Link>
              </Button>
            </div>
            {images.length > 0 && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-5">
                {images.map((image, index) => (
                  <div key={image.id} className="overflow-hidden rounded-md border bg-card">
                    <div className="relative aspect-square bg-muted/30">
                      <img src={image.dataUrl || image.url} alt={`صورة المنتج ${index + 1}`} className="size-full object-cover" />
                      {image.isPrimary && <span className="absolute right-1 top-1 rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">رئيسية</span>}
                    </div>
                    <button
                      type="button"
                      className="flex min-h-9 w-full items-center justify-center gap-1 border-t px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                      onClick={() => onImagesChange?.(images.filter((item) => item.id !== image.id))}
                      disabled={!onImagesChange}
                      aria-label={`إزالة صورة المنتج ${index + 1} عند الحفظ`}
                    >
                      <Trash2 aria-hidden className="size-3.5" /> إزالة عند الحفظ
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
