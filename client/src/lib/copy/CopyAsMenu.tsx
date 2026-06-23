// قائمة «نسخ كَـ...» — زر مع قائمة منسدلة تختار صيغة النسخ (نص خام/واتساب/TSV).
// لتفادي إغراق الجداول بثلاثة أزرار منفصلة، وللحفاظ على تناسق رسائل التأكيد عبر النظام.
//   <CopyAsMenu plain={inv.number} whatsapp={waText} tsv={tsvRow} />
//   <CopyAsMenu plain={c.phone} />                                  // خيار واحد ⇒ يتحوّل لزر نسخ مباشر
import * as React from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useClipboard } from "@/hooks/useClipboard";

export type CopyFormat = "plain" | "whatsapp" | "tsv";

type ButtonVariant = React.ComponentProps<typeof Button>["variant"];
type ButtonSize = "sm" | "default" | "icon-sm" | "icon";

export type CopyAsMenuProps = {
  /** نص خام لـplain (الافتراضي). */
  plain?: string;
  /** نص منسّق لواتساب. لو غاب، الخيار يختفي. */
  whatsapp?: string;
  /** نص TSV. لو غاب، الخيار يختفي. */
  tsv?: string;
  /** تسمية مخصّصة للزر. الافتراضي «نسخ». */
  label?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
};

const FORMAT_LABEL_AR: Record<CopyFormat, string> = {
  plain: "نص",
  whatsapp: "واتساب",
  tsv: "TSV",
};

const FORMAT_MENU_LABEL_AR: Record<CopyFormat, string> = {
  plain: "نسخ كنص",
  whatsapp: "نسخ لواتساب",
  tsv: "نسخ كـTSV",
};

/** زر نسخ متعدّد الصيغ. عند توفّر صيغة واحدة فقط يعمل كزر نسخ مباشر بلا قائمة. */
export function CopyAsMenu({
  plain,
  whatsapp,
  tsv,
  label = "نسخ",
  size = "sm",
  variant = "outline",
  className,
}: CopyAsMenuProps) {
  const { copied, copy } = useClipboard({ successMessage: null });

  // اجمع الصيغ المتاحة بترتيب ثابت (plain أوّلاً).
  const formats = React.useMemo(() => {
    const list: { key: CopyFormat; value: string }[] = [];
    if (plain != null && String(plain) !== "") list.push({ key: "plain", value: String(plain) });
    if (whatsapp != null && String(whatsapp) !== "")
      list.push({ key: "whatsapp", value: String(whatsapp) });
    if (tsv != null && String(tsv) !== "") list.push({ key: "tsv", value: String(tsv) });
    return list;
  }, [plain, whatsapp, tsv]);

  const handleCopy = React.useCallback(
    async (fmt: CopyFormat, value: string) => {
      const ok = await copy(value);
      if (ok) {
        const { notify } = await import("@/lib/notify");
        notify.ok(`تم النسخ كـ${FORMAT_LABEL_AR[fmt]}`);
      }
    },
    [copy],
  );

  // لا صيغ متاحة ⇒ زر معطّل.
  if (formats.length === 0) {
    return (
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled
        aria-label={label}
        title={label}
      >
        <Copy />
        {!isIconSize(size) && <span>{label}</span>}
      </Button>
    );
  }

  // صيغة واحدة ⇒ زر نسخ مباشر بلا قائمة.
  if (formats.length === 1) {
    const only = formats[0];
    return (
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => void handleCopy(only.key, only.value)}
        aria-label={label}
        title={label}
      >
        {copied ? <Check className="text-emerald-600" /> : <Copy />}
        {!isIconSize(size) && <span>{label}</span>}
      </Button>
    );
  }

  // عدّة صيغ ⇒ قائمة منسدلة.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={cn(className)}
          aria-label={`${label} — اختر الصيغة`}
          title={label}
        >
          {copied ? <Check className="text-emerald-600" /> : <Copy />}
          {!isIconSize(size) && <span>{label}</span>}
          <ChevronDown className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        {formats.map((f) => (
          <DropdownMenuItem
            key={f.key}
            onSelect={(e) => {
              e.preventDefault();
              void handleCopy(f.key, f.value);
            }}
            aria-label={FORMAT_MENU_LABEL_AR[f.key]}
          >
            <Copy />
            <span>{FORMAT_MENU_LABEL_AR[f.key]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isIconSize(size: ButtonSize): boolean {
  return size === "icon" || size === "icon-sm";
}

export default CopyAsMenu;
