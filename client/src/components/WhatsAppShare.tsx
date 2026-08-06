import { Button } from "@/components/ui/button";
import { openWhatsApp, preferredWhatsAppPhone } from "@/lib/whatsapp";
import { MessageCircle } from "lucide-react";

interface Props {
  phone?: string | null;
  whatsapp?: string | null;
  alternativePhones?: Array<string | null | undefined>;
  message: string;
  label?: string;
  size?: "sm" | "default" | "icon-sm";
  className?: string;
  iconOnly?: boolean;
  disabledReason?: string;
}

/** زر "إرسال واتساب" — يفتح تطبيق واتساب مباشرةً مع رجوع آمن إلى wa.me. */
export function WhatsAppShare({
  phone,
  whatsapp,
  alternativePhones = [],
  message,
  label = "إرسال واتساب",
  size = "sm",
  className,
  iconOnly = false,
  disabledReason = "لا يوجد رقم واتساب صالح — أضف الرقم إلى بيانات الطرف أولاً",
}: Props) {
  const targetPhone = preferredWhatsAppPhone(whatsapp, phone, ...alternativePhones);
  return (
    <Button
      variant="outline"
      size={size}
      style={{ borderColor: "color-mix(in oklch, var(--brand-whatsapp) 50%, transparent)", color: "var(--brand-whatsapp)" }}
      className={`gap-1.5 hover:brightness-110 ${className ?? ""}`}
      onClick={() => targetPhone && openWhatsApp(targetPhone, message)}
      type="button"
      disabled={!targetPhone}
      title={!targetPhone ? disabledReason : label}
      aria-label={iconOnly ? (!targetPhone ? `${label}: ${disabledReason}` : label) : undefined}
    >
      <MessageCircle className="size-4 shrink-0" aria-hidden />
      {!iconOnly && <span>{label}</span>}
    </Button>
  );
}
