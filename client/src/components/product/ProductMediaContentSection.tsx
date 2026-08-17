import { ImageStudioUploader } from "@/components/product/ImageStudioUploader";
import type { ImageItem } from "@/components/form/ImageUploader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useRef } from "react";

interface Props {
  description: string;
  onDescriptionChange: (value: string) => void;
  images: ImageItem[];
  onImagesChange: (value: ImageItem[]) => void;
  marketingCopy?: string;
  onMarketingCopyChange?: (value: string) => void;
  maxImages?: number;
  title?: string;
  hint?: string;
  onOriginalCaptured?: (dataUrl: string) => void;
  onStudioModeChange?: (mode: "FLATTEN" | "CUT" | "AI") => void;
  studioTaskId?: number;
  onProcessingReceiptChange?: (receipt: string | null) => void;
}

/** القسم الموحّد للصور والمحتوى في الإنشاء والتعديل ومركز الاستوديو. */
export function ProductMediaContentSection({
  description,
  onDescriptionChange,
  images,
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
    onImagesChange(next);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          نفس القسم في الإنشاء والتعديل والاستوديو؛ الأصل محفوظ، والمرشّح لا يظهر في المتجر قبل الاعتماد.
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
        <ImageStudioUploader value={images} onChange={handleImages} maxItems={maxImages} hint={hint} onStudioModeChange={onStudioModeChange} studioTaskId={studioTaskId} onProcessingReceiptChange={onProcessingReceiptChange} />
      </CardContent>
    </Card>
  );
}
