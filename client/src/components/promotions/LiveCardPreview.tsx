import { useState, useMemo } from "react";
import { Check, Copy, Printer, Sparkles, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatIqd, moneyInput } from "@/lib/money";
import { notify } from "@/lib/notify";
import { qrSvgSync } from "@/lib/printing/qr";
import { printCouponCards } from "@/lib/printing/couponCard";
import { BRAND, CO } from "@/lib/printing/brand";
import { storefrontUrl } from "@/lib/siteHosts";
import type { PromotionFormData } from "./promotionBuilderTypes";

interface LiveCardPreviewProps {
  data: PromotionFormData;
}

export function LiveCardPreview({ data }: LiveCardPreviewProps) {
  const [copied, setCopied] = useState(false);
  const [printing, setPrinting] = useState(false);

  const previewCode = useMemo(() => {
    const raw = data.sampleCode.trim() || `${data.codePrefix || "VIP"}-8899`;
    return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  }, [data.sampleCode, data.codePrefix]);

  const smartStoreUrl = useMemo(() => {
    return `${storefrontUrl()}?coupon=${previewCode}`;
  }, [previewCode]);

  const qrSvg = useMemo(() => {
    return qrSvgSync(smartStoreUrl, 130);
  }, [smartStoreUrl]);

  const accentColor = useMemo(() => {
    return /^#[0-9a-fA-F]{6}$/.test(data.design.color) ? data.design.color : BRAND.green;
  }, [data.design.color]);

  const discountSummary = useMemo(() => {
    if (data.type === "PERCENT") {
      const cap = moneyInput(data.maxDiscountAmount);
      const capText = cap.greaterThan(0) ? ` (سقف: ${formatIqd(data.maxDiscountAmount)})` : "";
      return `خصم ${data.discountPercent || "0"}٪${capText}`;
    }
    return `خصم بقيمة ${formatIqd(data.discountAmount || "0")}`;
  }, [data.type, data.discountPercent, data.maxDiscountAmount, data.discountAmount]);

  const heroDiscountText = useMemo(() => {
    if (data.type === "PERCENT") {
      return `خصم ${data.discountPercent || "0"}٪`;
    }
    return `خصم ${formatIqd(data.discountAmount || "0")}`;
  }, [data.type, data.discountPercent, data.discountAmount]);

  const minSpendText = useMemo(() => {
    const min = moneyInput(data.minOrderSpend);
    return min.greaterThan(0) ? `للطلبات بقيمة ${formatIqd(data.minOrderSpend)} فأكثر` : null;
  }, [data.minOrderSpend]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(previewCode);
      setCopied(true);
      notify.ok(`تم نسخ رمز الكوبون: ${previewCode}`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify.err("تعذر النسخ إلى الحافظة");
    }
  }

  async function handlePrint() {
    setPrinting(true);
    try {
      const card = {
        code: previewCode,
        title: data.design.title || data.name || "هدية خاصة لك",
        subtitle: data.design.subtitle || discountSummary,
        heroDiscount: heroDiscountText,
        minSpend: minSpendText,
        terms: data.design.terms || "تُطبق الشروط والأحكام الخاصة بالعرض.",
        validTo: data.validTo || null,
        color: accentColor,
        storeUrl: smartStoreUrl,
      };
      const ok = await printCouponCards([card], { layout: "CARD" });
      if (!ok) {
        notify.err("اسمح بنوافذ الطباعة المنبثقة لإتمام الطباعة");
      }
    } catch (error) {
      notify.err(error);
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5 self-start">
        <Sparkles className="size-3.5 text-primary" />
        <span>بطاقة الكوبون الفاخرة (أبعاد معيارية 54×84 مم)</span>
      </div>

      {/* بطاقة الكوبون بأبعاد 54×84 مم متناسبة مع الشاشة */}
      <Card
        className="w-full max-w-[280px] overflow-hidden rounded-xl border-2 shadow-lg transition-all duration-200"
        style={{
          borderColor: accentColor,
          aspectRatio: "54 / 84",
        }}
      >
        <CardContent className="h-full p-3.5 flex flex-col justify-between text-center bg-card relative selection:bg-primary/20">
          {/* شريط الإطار العلوي باللون المميز */}
          <div
            className="absolute top-0 inset-x-0 h-1.5"
            style={{ backgroundColor: accentColor }}
          />

          {/* الترويسة والعلامة التجارية */}
          <div className="pt-0.5 space-y-0.5">
            <div className="flex items-center justify-center gap-1.5 text-xs font-black text-foreground">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: accentColor }}
              />
              <span>{CO.short}</span>
            </div>
            <div
              className="text-[9.5px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded-full inline-block border"
              style={{
                borderColor: `color-mix(in srgb, ${accentColor} 45%, transparent)`,
                color: accentColor,
                backgroundColor: `color-mix(in srgb, ${accentColor} 10%, transparent)`,
              }}
            >
              قسيمة خصم رسمية
            </div>
          </div>

          {/* العنوان الرئيسي */}
          <div className="my-0.5">
            <h4 className="font-black text-sm tracking-tight text-foreground line-clamp-1">
              {data.design.title || data.name || "هدية خاصة لك"}
            </h4>
          </div>

          {/* صندوق الخصم البارز (Hero Discount Box) */}
          <div
            className="rounded-lg p-2 my-0.5 border flex flex-col items-center justify-center"
            style={{
              backgroundColor: `color-mix(in srgb, ${accentColor} 10%, transparent)`,
              borderColor: `color-mix(in srgb, ${accentColor} 30%, transparent)`,
            }}
          >
            <div className="flex items-baseline gap-1" style={{ color: accentColor }}>
              <span className="text-2xl font-black tracking-tight leading-none">
                {data.type === "PERCENT" ? `${data.discountPercent || "0"}٪` : formatIqd(data.discountAmount || "0")}
              </span>
              <span className="text-xs font-black">خصم</span>
            </div>
            {data.type === "PERCENT" && moneyInput(data.maxDiscountAmount).greaterThan(0) && (
              <div className="text-[9.5px] font-bold text-foreground mt-0.5">
                سقف التوفير: {formatIqd(data.maxDiscountAmount)}
              </div>
            )}
            {minSpendText && (
              <div className="text-[9px] font-bold text-muted-foreground mt-0.5">
                {minSpendText}
              </div>
            )}
          </div>

          {/* رمز الاستجابة السريعة QR الذكي */}
          <div className="my-0.5 flex flex-col items-center justify-center">
            <div className="bg-white p-1.5 rounded-lg border shadow-sm flex items-center justify-center">
              {qrSvg ? (
                <div
                  className="size-20 flex items-center justify-center [&>svg]:size-full"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                  aria-label={`رمز QR للكوبون ${previewCode}`}
                />
              ) : (
                <div className="size-20 flex items-center justify-center bg-muted text-muted-foreground">
                  <QrCode className="size-7" />
                </div>
              )}
            </div>
            <span className="text-[9px] font-bold text-muted-foreground mt-0.5">
              امسح للطلب أونلاين أو أبرز الرمز للكاشير
            </span>
          </div>

          {/* حقل الرمز المقروء بشرياً */}
          <div className="space-y-0.5">
            <div
              className="group relative flex items-center justify-center gap-2 rounded-md border-2 border-dashed py-1 px-3 bg-muted/30 font-mono text-sm font-black tracking-wider text-foreground cursor-pointer hover:bg-muted"
              style={{ borderColor: `color-mix(in srgb, ${accentColor} 50%, transparent)` }}
              onClick={handleCopy}
              title="انقر لنسخ الرمز"
            >
              <span dir="ltr">{previewCode}</span>
              {copied ? (
                <Check className="size-3.5 text-primary" />
              ) : (
                <Copy className="size-3.5 text-muted-foreground opacity-60 group-hover:opacity-100" />
              )}
            </div>

            {/* تاريخ الصلاحية */}
            <div className="text-[9.5px] font-bold text-foreground flex justify-between items-center px-1">
              <span>الصلاحية:</span>
              <span className="font-extrabold text-foreground">
                {data.validTo ? data.validTo : "حتى نفاد الحملة"}
              </span>
            </div>
          </div>

          {/* التذييل والشروط */}
          <div className="pt-1 border-t text-[8.5px] font-medium text-muted-foreground line-clamp-1 leading-normal">
            {data.design.terms || "تُطبق الشروط والأحكام. غير قابل للدمج مع عروض أخرى."}
          </div>
        </CardContent>
      </Card>

      {/* أزرار الإجراءات للبطاقة */}
      <div className="flex items-center gap-2 w-full max-w-[280px]">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1 text-xs"
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          <span>{copied ? "تم النسخ" : "نسخ الرمز"}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1 text-xs"
          onClick={handlePrint}
          disabled={printing}
        >
          <Printer className="size-3.5" />
          <span>{printing ? "تحضير…" : "طباعة 54×84"}</span>
        </Button>
      </div>
    </div>
  );
}
