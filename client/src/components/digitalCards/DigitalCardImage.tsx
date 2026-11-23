import type { ImageItem } from "@/components/form/ImageUploader";
import { cn } from "@/lib/utils";
import { Building2, CreditCard } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";

/**
 * يحوّل رابط صورة خفيف (`/api/img/digital-*`) إلى عنصر `ImageItem` مبدئي داخل `ImageUploader`
 * دون تخزين data URL في الحالة؛ فيبقى الحفظ اللاحق بلا أيّ إرسالٍ للصورة إن لم تتغيّر.
 */
export function toExistingImageItems(url: string | null | undefined): ImageItem[] {
  return url ? [{ id: "existing", dataUrl: "", url, isPrimary: true }] : [];
}

/**
 * عقد إرسال الصورة عند الحفظ:
 * - `undefined` عند عدم التغيير (`!img.dataUrl && img.url`) كي لا تُمسّ الصورة المخزّنة.
 * - `null` عند المسح (`images.length === 0`) لاستعادة الوراثة أو إزالة الشعار.
 * - `img.dataUrl` عند رفع صورة جديدة.
 */
export function resolveImageFormSubmission(
  images: ImageItem[],
): string | null | undefined {
  if (images.length === 0) return null;
  const img = images[0];
  if (img.dataUrl) return img.dataUrl;
  if (img.url) return undefined;
  return null;
}

export function DigitalCardThumbnail({
  src,
  alt,
  fallback = "card",
  className,
  style,
  iconClassName,
  iconStyle,
  iconSize = 18,
}: {
  src: string | null | undefined;
  alt: string;
  fallback?: "provider" | "card";
  className?: string;
  style?: CSSProperties;
  iconClassName?: string;
  iconStyle?: CSSProperties;
  iconSize?: number;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const FallbackIcon = fallback === "provider" ? Building2 : CreditCard;

  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-md border bg-muted/30",
        className,
      )}
      style={style}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <FallbackIcon
          aria-hidden
          size={iconSize}
          className={cn("text-muted-foreground", iconClassName)}
          style={iconStyle}
        />
      )}
    </div>
  );
}
