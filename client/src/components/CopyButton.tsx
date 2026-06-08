// أزرار النسخ للحافظة — لتفادي النقل اليدوي الخاطئ.
//   <CopyButton value={invoice.invoiceNumber} />            زر أيقونة (ترويسات/تفاصيل)
//   <CopyInline value={c.phone} />                           نسخ ضمن خلية جدول (هاتف/باركود/أرقام مستندات)
import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useClipboard } from "@/hooks/useClipboard";

export type CopyButtonProps = {
  value: string | number | null | undefined;
  title?: string;
  size?: "icon-sm" | "icon" | "sm";
  variant?: React.ComponentProps<typeof Button>["variant"];
  className?: string;
  successMessage?: string | null;
};

/** زر أيقونة نسخ (Copy ↔ Check). يُعطَّل على القيمة الفارغة. */
export function CopyButton({
  value,
  title = "نسخ",
  size = "icon-sm",
  variant = "ghost",
  className,
  successMessage,
}: CopyButtonProps) {
  const { copied, copy } = useClipboard({ successMessage: successMessage ?? "تم النسخ" });
  const empty = value == null || String(value) === "";
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      title={title}
      aria-label={title}
      disabled={empty}
      onClick={() => void copy(value)}
    >
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
    </Button>
  );
}

export type CopyInlineProps = {
  value: string | number | null | undefined;
  /** المحتوى المعروض (افتراضياً = القيمة) — يسمح بعرض منسّق مع نسخ القيمة الخام. */
  display?: React.ReactNode;
  /** خط أحادي + اتجاه LTR (للهواتف/الباركود/الأرقام). افتراضي true. */
  mono?: boolean;
  className?: string;
  successMessage?: string | null;
};

/** نسخ ضمن خلية: يعرض القيمة وأيقونة نسخ تظهر عند المرور/التركيز. */
export function CopyInline({
  value,
  display,
  mono = true,
  className,
  successMessage,
}: CopyInlineProps) {
  const { copied, copy } = useClipboard({ successMessage: successMessage ?? "تم النسخ" });
  const text = value == null ? "" : String(value);
  if (!text) return <span className="text-muted-foreground">{display ?? "—"}</span>;
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      aria-label={`نسخ ${text}`}
      className={cn(
        "group inline-flex max-w-full items-center gap-1 -mx-1 rounded px-1 text-start hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        mono && "font-mono text-xs",
        className,
      )}
      dir={mono ? "ltr" : undefined}
    >
      <span className="truncate">{display ?? text}</span>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-emerald-600" />
      ) : (
        <Copy className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-60" />
      )}
    </button>
  );
}
