import { useMemo, useState } from "react";
import { Check, CheckCheck, Copy, Edit3, MessageSquare, RotateCcw, Send, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
import { WhatsAppShare } from "@/components/WhatsAppShare";
import { formatIqd, moneyInput } from "@/lib/money";
import { CO } from "@/lib/printing/brand";
import { storefrontUrl } from "@/lib/siteHosts";
import { sanitizeForWhatsApp } from "@/lib/whatsapp";
import { notify } from "@/lib/notify";
import type { PromotionFormData } from "./promotionBuilderTypes";

interface LiveWhatsAppPreviewProps {
  data: PromotionFormData;
}

type MessageStyle = "PROMO" | "GIFT" | "FLASH";

export function LiveWhatsAppPreview({ data }: LiveWhatsAppPreviewProps) {
  const [recipientPhone, setRecipientPhone] = useState<string>("07700000000");
  const [style, setStyle] = useState<MessageStyle>("PROMO");
  const [isCustomEditing, setIsCustomEditing] = useState<boolean>(false);
  const [customText, setCustomText] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);

  const previewCode = useMemo(() => {
    const raw = data.sampleCode.trim() || `${data.codePrefix || "VIP"}-8899`;
    return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  }, [data.sampleCode, data.codePrefix]);

  const smartStoreUrl = useMemo(() => {
    return `${storefrontUrl()}?coupon=${previewCode}`;
  }, [previewCode]);

  const discountSummary = useMemo(() => {
    if (data.type === "PERCENT") {
      const cap = moneyInput(data.maxDiscountAmount);
      const capText = cap.greaterThan(0) ? ` (سقف التوفير: ${formatIqd(data.maxDiscountAmount)})` : "";
      return `خصم ${data.discountPercent || "0"}٪${capText}`;
    }
    return `خصم بقيمة ${formatIqd(data.discountAmount || "0")}`;
  }, [data.type, data.discountPercent, data.maxDiscountAmount, data.discountAmount]);

  const minSpendSummary = useMemo(() => {
    const min = moneyInput(data.minOrderSpend);
    return min.greaterThan(0) ? formatIqd(data.minOrderSpend) : "بلا حد أدنى";
  }, [data.minOrderSpend]);

  const validityText = useMemo(() => {
    return data.validTo ? data.validTo : "لفترة محدودة أو حتى نفاد الكمية";
  }, [data.validTo]);

  // صياغة الرسائل الترويجية الذكية وفق الأنماط التسويقية المعتمدة (خالية تماماً من الإيموجي)
  const generatedMessage = useMemo(() => {
    const title = data.design.title || data.name || "عرض خاص";
    const subtitle = data.design.subtitle ? data.design.subtitle : null;
    const terms = data.design.terms || "يُستخدم لمرة واحدة ولا يُجمع مع عروض أخرى.";
    const shippingBonus = data.freeShipping ? "\n• ميزة إضافية: توصيل مجاني مشمول" : "";

    const joinLines = (lines: (string | null | undefined | false)[]) =>
      lines.filter((l): l is string => l != null && l !== false).join("\n");

    if (style === "GIFT") {
      return joinLines([
        `*هدية تسوق خاصة لك من ${CO.short}*`,
        `تقديراً لثقتكم بنا، يسعدنا إهداؤك قسيمة الشراء الحصرية: *${previewCode}*`,
        ``,
        `*${title}*`,
        subtitle,
        `• قيمة الهدية: *${discountSummary}*`,
        `• الحد الأدنى للمشتريات: ${minSpendSummary}${shippingBonus}`,
        `• سارية لغاية: ${validityText}`,
        ``,
        `*رابط التسوق المباشر بالخصم:*`,
        `${smartStoreUrl}`,
        `(أو تفضل بزيارة أقرب فرع وأبرز الرمز عند الدفع)`,
        ``,
        `• الشروط: ${terms}`,
      ]);
    }

    if (style === "FLASH") {
      return joinLines([
        `*تخفيض استثنائي ولفترة محدودة من ${CO.short}!*`,
        `سارع بالاستفادة من كوبون الخصم الحصري: *${previewCode}*`,
        ``,
        `• احصل فوراً على: *${discountSummary}*`,
        `• عند الشراء بقيمة: ${minSpendSummary}${shippingBonus}`,
        `• سارع بالطلب قبل انتهاء العرض: ${validityText}`,
        ``,
        `*رابط التفعيل الفوري للكوبون:*`,
        `${smartStoreUrl}`,
        `أو امسح الرمز لدى الكاشير في الفرع مباشرة.`,
        ``,
        `• الشروط: ${terms}`,
      ]);
    }

    // Default: PROMO
    return joinLines([
      `*عرض خاص وحصري من ${CO.short}!*`,
      `وفر الآن مع كوبون الخصم: *${previewCode}*`,
      ``,
      `*${title}*`,
      subtitle,
      `• قيمة الخصم: *${discountSummary}*`,
      `• الحد الأدنى للطلب: ${minSpendSummary}${shippingBonus}`,
      `• الصلاحية: ${validityText}`,
      ``,
      `*طريقة الاستخدام:*`,
      `1. للطلب أونلاين وتفعيل الخصم فوراً:`,
      `${smartStoreUrl}`,
      `2. أو أظهر الرمز للكاشير عند زيارة فرعنا.`,
      ``,
      `• الشروط: ${terms}`,
    ]);
  }, [
    style,
    data.design.title,
    data.design.subtitle,
    data.design.terms,
    data.name,
    data.freeShipping,
    validityText,
    previewCode,
    discountSummary,
    minSpendSummary,
    smartStoreUrl,
  ]);

  const activeMessage = isCustomEditing ? customText : generatedMessage;

  async function handleCopyMessage() {
    try {
      await navigator.clipboard.writeText(sanitizeForWhatsApp(activeMessage));
      setCopied(true);
      notify.ok("تم نسخ نص رسالة WhatsApp الترويجية");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify.err("تعذر النسخ إلى الحافظة");
    }
  }

  function handleStartCustomEdit() {
    setCustomText(generatedMessage);
    setIsCustomEditing(true);
  }

  function handleResetToGenerated() {
    setIsCustomEditing(false);
    setCustomText("");
    notify.ok("تمت استعادة النص الترويجي المولد تلقائياً");
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center justify-between w-full max-w-[340px]">
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <MessageSquare className="size-3.5 text-primary" />
          <span>رسالة WhatsApp الترويجية الذكية</span>
        </div>
        <div className="text-[10px] text-muted-foreground flex items-center gap-1 font-medium">
          <Sparkles className="size-3 text-primary" />
          <span>رابط المتجر الفعلي</span>
        </div>
      </div>

      {/* منتقي النمط التسويقي للرسالة */}
      <div className="w-full max-w-[340px] flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-muted-foreground">النمط التسويقي:</span>
          {isCustomEditing ? (
            <button
              type="button"
              className="text-[11px] text-primary hover:underline flex items-center gap-1 font-medium"
              onClick={handleResetToGenerated}
            >
              <RotateCcw className="size-3" />
              <span>استعادة التلقائي</span>
            </button>
          ) : (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium"
              onClick={handleStartCustomEdit}
            >
              <Edit3 className="size-3" />
              <span>تعديل يدوي</span>
            </button>
          )}
        </div>

        {!isCustomEditing ? (
          <div className="grid grid-cols-3 gap-1 pt-1">
            <button
              type="button"
              className={`py-1 px-1.5 rounded text-[10.5px] font-semibold transition-colors border ${
                style === "PROMO"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-muted text-muted-foreground border-border"
              }`}
              onClick={() => setStyle("PROMO")}
            >
              ترويجي مباشر
            </button>
            <button
              type="button"
              className={`py-1 px-1.5 rounded text-[10.5px] font-semibold transition-colors border ${
                style === "GIFT"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-muted text-muted-foreground border-border"
              }`}
              onClick={() => setStyle("GIFT")}
            >
              هدية ومكافأة
            </button>
            <button
              type="button"
              className={`py-1 px-1.5 rounded text-[10.5px] font-semibold transition-colors border ${
                style === "FLASH"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-muted text-muted-foreground border-border"
              }`}
              onClick={() => setStyle("FLASH")}
            >
              تخفيض عاجل
            </button>
          </div>
        ) : (
          <div className="pt-1">
            <Textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              className="text-xs font-sans min-h-[90px] leading-relaxed resize-y bg-background"
              placeholder="اكتب أو عدل نص الرسالة الترويجية هنا…"
            />
          </div>
        )}
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
            <pre className="whitespace-pre-wrap font-sans text-xs select-text leading-relaxed">
              {activeMessage}
            </pre>

            {/* وقت الإرسال وعلامة القراءة المزدوجة */}
            <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground font-mono">
              <span>الآن</span>
              <CheckCheck className="size-3.5 text-blue-500" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* أزرار الإجراءات وحقل إدخال الهاتف */}
      <div className="w-full max-w-[340px] space-y-2 rounded-lg border bg-card p-3 shadow-sm">
        <div className="flex items-center gap-2 pb-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1 text-xs gap-1.5"
            onClick={handleCopyMessage}
          >
            {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
            <span>{copied ? "تم النسخ" : "نسخ نص الرسالة"}</span>
          </Button>
        </div>

        <label className="text-xs font-medium text-foreground block">
          رقم المستلم للإرسال الميداني:
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
            message={activeMessage}
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
