import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Clock,
  MessageCircle,
  Phone,
  PhoneCall,
  PhoneMissed,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildOnlineOrderFollowupMessage, openWhatsApp } from "@/lib/whatsapp";

export type ContactStatus =
  | "NOT_CONTACTED"
  | "WHATSAPP_SENT"
  | "CALLED_CONFIRMED"
  | "NO_ANSWER"
  | "RETRY";

export interface OrderContactCellProps {
  order: {
    id: number;
    orderNumber: string;
    customerName: string | null;
    customerPhone: string | null;
    total: string | number | null;
    status: string;
    contactStatus?: string | null;
    contactNotes?: string | null;
  };
  onUpdateContact: (status: ContactStatus, notes?: string) => void | Promise<void>;
  isUpdating?: boolean;
}

const CONTACT_STATUS_MAP: Record<
  ContactStatus,
  { label: string; icon: typeof Phone; colorClass: string }
> = {
  NOT_CONTACTED: {
    label: "لم يتم التواصل",
    icon: Clock,
    colorClass: "bg-muted text-muted-foreground border-border",
  },
  WHATSAPP_SENT: {
    label: "أُرسل واتساب",
    icon: MessageCircle,
    colorClass: "bg-[var(--sem-info-bg)] text-[var(--sem-info)] border-[var(--sem-info)]/30",
  },
  CALLED_CONFIRMED: {
    label: "مؤكّد هاتفياً",
    icon: CheckCircle2,
    colorClass: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)] border-[var(--sem-pos)]/30",
  },
  NO_ANSWER: {
    label: "لا يرد",
    icon: PhoneMissed,
    colorClass: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)] border-[var(--sem-warn)]/40",
  },
  RETRY: {
    label: "إعادة محاولة",
    icon: RotateCcw,
    colorClass: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)] border-[var(--sem-neg)]/30",
  },
};

export function OrderContactCell({
  order,
  onUpdateContact,
  isUpdating = false,
}: OrderContactCellProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const cleanPhone = order.customerPhone?.trim() || "";
  const currentStatus = (order.contactStatus as ContactStatus) || "NOT_CONTACTED";
  const statusInfo = CONTACT_STATUS_MAP[currentStatus] || CONTACT_STATUS_MAP.NOT_CONTACTED;
  const StatusIcon = statusInfo.icon;

  const handleWhatsAppClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!cleanPhone) return;

    const message = buildOnlineOrderFollowupMessage({
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      total: order.total != null ? String(order.total) : "0",
      status: order.status,
    });

    openWhatsApp(cleanPhone, message);

    // تحديث الحالة تلقائياً إلى "أُرسل واتساب" إذا لم تكن مؤكدة مسبقاً
    if (currentStatus === "NOT_CONTACTED") {
      void onUpdateContact("WHATSAPP_SENT");
    }
  };

  const handleCallClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!cleanPhone) return;
    window.open(`tel:${cleanPhone}`);
  };

  return (
    <div className="flex flex-col gap-1.5 min-w-[11rem]">
      {/* اسم العميل ورقم الهاتف */}
      <div className="flex flex-col">
        <span className="font-semibold text-foreground text-xs truncate max-w-[12rem]" title={order.customerName ?? "—"}>
          {order.customerName ?? "—"}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground tracking-wide dir-ltr text-end self-start" dir="ltr">
          {cleanPhone || "—"}
        </span>
      </div>

      {/* أزرار الاتصال والواتساب السريعة */}
      <div className="flex items-center gap-1">
        {cleanPhone ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] font-bold gap-1 text-[#25D366] border-[#25D366]/40 hover:bg-[#25D366]/10 hover:text-[#25D366]"
              onClick={handleWhatsAppClick}
              title="مراسلة العميل عبر واتساب لتثبيت الطلب"
              disabled={isUpdating}
            >
              <MessageCircle className="size-3.5 shrink-0" aria-hidden />
              <span>واتساب</span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground hover:bg-accent"
              onClick={handleCallClick}
              title="اتصال هاتفي بالعميل"
              disabled={isUpdating}
            >
              <PhoneCall className="size-3.5 shrink-0" aria-hidden />
              <span className="sr-only">اتصال</span>
            </Button>
          </>
        ) : null}

        {/* منسدلة حالة الاتصال */}
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={isUpdating}
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold transition hover:opacity-85 ${statusInfo.colorClass}`}
              title={order.contactNotes ? `${statusInfo.label} — ${order.contactNotes}` : statusInfo.label}
              onClick={(e) => e.stopPropagation()}
            >
              <StatusIcon className="size-3 shrink-0" aria-hidden />
              <span>{statusInfo.label}</span>
              <ChevronDown className="size-2.5 opacity-60" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            {(Object.keys(CONTACT_STATUS_MAP) as ContactStatus[]).map((key) => {
              const item = CONTACT_STATUS_MAP[key];
              const ItemIcon = item.icon;
              return (
                <DropdownMenuItem
                  key={key}
                  className="flex items-center gap-2 text-xs font-semibold"
                  onClick={() => void onUpdateContact(key)}
                >
                  <ItemIcon className="size-3.5 shrink-0" aria-hidden />
                  <span>{item.label}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
