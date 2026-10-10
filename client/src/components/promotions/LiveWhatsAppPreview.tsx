import { useMemo, useState } from "react";
import { CheckCheck, MessageSquare, Send, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { formatIqd } from "@/lib/money";
import { CO } from "@/lib/printing/brand";
import type { PromotionFormData } from "./promotionBuilderTypes";

interface LiveWhatsAppPreviewProps {
  data: PromotionFormData;
}

export function LiveWhatsAppPreview({ data }: LiveWhatsAppPreviewProps) {
  const [recipientPhone, setRecipientPhone] = useState<string>("07700000000");

  const previewCode = useMemo(() => {
    const raw = data.sampleCode.trim() || `${data.codePrefix || "VIP"}-8899`;
    return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  }, [data.sampleCode, data.codePrefix]);

  const discountSummary = useMemo(() => {
    if (data.type === "PERCENT") {
      const cap = parseFloat(data.maxDiscountAmount);
      const capText = !isNaN(cap) && cap > 0 ? ` (بسقف أقصى ${formatIqd(data.maxDiscountAmount)})` : "";
      return `خصم ${data.discountPercent || "0"}٪${capText}`;
    }
    return `خصم بقيمة ${formatIqd(data.discountAmount || "0")}`;
  }, [data.type, data.discountPercent, data.maxDiscountAmount, data.discountAmount]);

  const minSpendSummary = useMemo(() => {
    const min = parseFloat(data.minOrderSpend);
    return !isNaN(min) && min > 0 ? formatIqd(data.minOrderSpend) : "بلا حد أدنى";
  }, [data.minOrderSpend]);

  // صياغة رسالة الواتساب التسويقية الاحترافية باللغة العربية (خالية من الإيموجي تماماً)
  const formattedMessage = useMemo(() => {
    const lines: string[] = [
      `السلام عليكم ورحمة الله وبركاته،`,
      `تحية طيبة من ${CO.short}،`,
      ``,
      `يسرنا إهداؤك هذا العرض الترويجي الحصري:`,
      `*${data.design.title || data.name || "عرض خاص"}*`,
      `${data.design.subtitle || ""}`,
      ``,
      `رمز الكوبون: *${previewCode}*`,
      `قيمة الخصم: *${discountSummary}*`,
      `الحد الأدنى للطلب: ${minSpendSummary}`,
    ];

    if (data.freeShipping) {
      lines.push(`ميزة إضافية: توصيل مجاني مشمول`);
    }

    if (data.validTo) {
      lines.push(`صالح لغاية: ${data.validTo}`);
    } else {
      lines.push(`صالح لفترة محدودة أو حتى نفاد الكمية`);
    }

    if (data.design.terms) {
      lines.push(`الشروط: ${data.design.terms}`);
    }

    lines.push(``);
    lines.push(`يمكنك استخدام الكوبون مباشرة لدى موظف الكاشير أو عبر المتجر:`);
    lines.push(`https://alruya.iq/offers/${previewCode}`);
    lines.push(``);
    lines.push(`نتشرف بخدمتكم دائماً.`);

    return lines.filter((l) => l !== null).join("\n");
  }, [
    data.design.title,
    data.design.subtitle,
    data.design.terms,
    data.name,
    data.freeShipping,
    data.validTo,
    previewCode,
    discountSummary,
    minSpendSummary,
  ]);

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center justify-between w-full max-w-[340px]">
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <MessageSquare className="size-3.5 text-primary" />
          <span>معاينة رسالة WhatsApp التسويقية</span>
        </div>
        <div className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Sparkles className="size-3 text-primary" />
          <span>توليد تلقائي للرسالة</span>
        </div>
      </div>

      {/* محاكاة واجهة محادثة الواتساب */}
      <Card className="w-full max-w-[340px] overflow-hidden rounded-xl border shadow-md bg-[#ECE5DD] dark:bg-muted/20">
        {/* شريط رأس المحادثة */}
        <div className="bg-[#075E54] text-white p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="size-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-xs text-white">
              {CO.short.slice(0, 2)}
            </div>
            <div>
              <div className="text-xs font-bold leading-tight">{CO.short}</div>
              <div className="text-[10px] text-emerald-200">حساب تجاري موثق</div>
            </div>
          </div>
          <Send className="size-4 text-emerald-200" />
        </div>

        {/* جسم المحادثة والفقاعة الخضراء الفاتحة */}
        <CardContent className="p-3 space-y-2">
          <div className="bg-[#DCF8C6] dark:bg-emerald-950/60 dark:text-emerald-100 text-neutral-900 p-3 rounded-lg rounded-tr-none shadow-sm text-xs leading-relaxed border border-emerald-200/50 dark:border-emerald-800/40 relative">
            <pre className="whitespace-pre-wrap font-sans text-xs select-text">
              {formattedMessage}
            </pre>

            {/* وقت الإرسال وعلامة القراءة المزدوجة */}
            <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground font-mono">
              <span>الآن</span>
              <CheckCheck className="size-3.5 text-blue-500" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* حقل إدخال الهاتف وزر الإرسال المباشر */}
      <div className="w-full max-w-[340px] space-y-2 rounded-lg border bg-card p-3 shadow-sm">
        <label className="text-xs font-medium text-foreground block">
          رقم المستلم للتجربة والإرسال الميداني:
        </label>
        <IntlPhoneInput
          value={recipientPhone}
          onChange={setRecipientPhone}
          ariaLabel="رقم هاتف مستلم رسالة الواتساب"
          className="h-9"
        />

        <div className="pt-1">
          <WhatsAppShare
            phone={recipientPhone}
            message={formattedMessage}
            label="إرسال عبر WhatsApp الآن"
            appearance="solid"
            size="default"
            className="w-full h-9 text-xs justify-center font-medium"
          />
        </div>
      </div>
    </div>
  );
}
