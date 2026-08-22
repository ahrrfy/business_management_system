/**
 * **شارة قناة وصول الطلب** — السطح الوحيد الذي يرسم القناة (١٩/٨).
 *
 * التسمية تأتي من `@shared/receptionChannel` (المصدر الحاكم) والأيقونة تُشتقّ من اسمها هناك،
 * فلا تُعيد أيّ شاشة تعريف القاموس ولا اختيار الأيقونات. كانت سبعةَ قواميس مُنجرفة.
 */
import { Circle, Instagram, MessageCircle, Music2, Phone, ShoppingBag, Store } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { receptionChannelIcon, receptionChannelLabel } from "@shared/receptionChannel";
import { WhatsAppIcon } from "./WhatsAppShare";

const ICON_BY_NAME: Record<string, LucideIcon> = {
  Store,
  MessageCircle,
  Instagram,
  Music2,
  Phone,
  ShoppingBag,
  Circle,
};

/** الأيقونة وحدها (للبطاقات الضيّقة في الكانبان). واتساب بأيقونته المميّزة بلونه. */
export function ChannelMark({
  channel,
  className = "size-3.5",
}: {
  channel: string | null | undefined;
  className?: string;
}) {
  if (channel === "WHATSAPP") {
    return <WhatsAppIcon className={`${className} text-[var(--brand-whatsapp)]`} />;
  }
  const Icon = ICON_BY_NAME[receptionChannelIcon(channel)] ?? Circle;
  return <Icon aria-hidden className={className} />;
}

/** أيقونة + اسم — للصفوف والتفاصيل حيث تتّسع المساحة. */
export function ChannelBadge({
  channel,
  handle,
  className = "",
}: {
  channel: string | null | undefined;
  /** المعرّف المرافق (رقم/حساب) — يُعرض بعد الاسم إن وُجد. */
  handle?: string | null;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
      <ChannelMark channel={channel} />
      <span>{receptionChannelLabel(channel)}</span>
      {handle ? <span className="text-muted-foreground">· {handle}</span> : null}
    </span>
  );
}
