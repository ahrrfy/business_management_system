/**
 * **شارة قناة الفاتورة** — أيّ محطّةٍ أصدرتها (١٩/٨، بلاغ المالك «لا تمييز بصريّ»).
 *
 * الاشتقاق في `@shared/invoiceChannel` (مصدرٌ واحد يحرسه اختبار)، واللون توكن `--chan-*`
 * من نظام التصميم (لا لون خامّ — حارس `check:colors`). القناة **هويّة لا حالة**، فتشبّعها
 * أدنى من `sem-*` عمداً كي لا تُزاحم إنذار الحالة والمال في نفس الصفّ.
 */
import { ClipboardList, FileText, Globe, Printer, ShoppingCart } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  deriveInvoiceChannel,
  invoiceChannelIcon,
  invoiceChannelLabel,
  invoiceChannelTone,
  type InvoiceChannelSource,
} from "@shared/invoiceChannel";

const ICON_BY_NAME: Record<string, LucideIcon> = {
  ShoppingCart,
  ClipboardList,
  Printer,
  Globe,
  FileText,
};

export default function InvoiceChannelBadge({
  row,
  /** `compact` = أيقونة وحدها بتلميح (للجداول الضيّقة). */
  compact = false,
  className = "",
}: {
  row: InvoiceChannelSource;
  compact?: boolean;
  className?: string;
}) {
  const ch = deriveInvoiceChannel(row);
  const label = invoiceChannelLabel(ch);
  const tone = invoiceChannelTone(ch);
  const Icon = ICON_BY_NAME[invoiceChannelIcon(ch)] ?? FileText;
  const style = { color: `var(--${tone})`, background: `var(--${tone}-bg)` };

  if (compact) {
    return (
      <span
        title={label}
        aria-label={label}
        className={`inline-grid size-5 place-items-center rounded ${className}`}
        style={style}
      >
        <Icon aria-hidden className="size-3" />
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap ${className}`}
      style={style}
    >
      <Icon aria-hidden className="size-3" />
      {label}
    </span>
  );
}
