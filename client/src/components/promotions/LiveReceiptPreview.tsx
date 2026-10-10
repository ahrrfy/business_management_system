import { useMemo, useState } from "react";
import { Receipt, AlertTriangle, CheckCircle2, SlidersHorizontal } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { D, formatIqd } from "@/lib/money";
import { code128Svg } from "@/lib/printing/barcode";
import { CO } from "@/lib/printing/brand";
import type { PromotionFormData } from "./promotionBuilderTypes";

interface LiveReceiptPreviewProps {
  data: PromotionFormData;
}

export function LiveReceiptPreview({ data }: LiveReceiptPreviewProps) {
  // محاكاة سلة مشتريات ديناميكية لتجربة صمامات الأمان المالية مباشرة على الإيصال
  const [simulatedSubtotal, setSimulatedSubtotal] = useState<number>(75000);

  const previewCode = useMemo(() => {
    const raw = data.sampleCode.trim() || `${data.codePrefix || "VIP"}-8899`;
    return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  }, [data.sampleCode, data.codePrefix]);

  const minSpend = useMemo(() => {
    const val = parseFloat(data.minOrderSpend);
    return isNaN(val) ? 0 : val;
  }, [data.minOrderSpend]);

  const isMinSpendMet = simulatedSubtotal >= minSpend;

  // الحساب المالي الدقيق للخصم مع احترام السقف المالي والحد الأدنى
  const calculation = useMemo(() => {
    if (!isMinSpendMet) {
      return {
        discountAmount: D(0),
        isCapped: false,
        total: D(simulatedSubtotal),
      };
    }

    let discount = D(0);
    let isCapped = false;

    if (data.type === "PERCENT") {
      const pct = parseFloat(data.discountPercent) || 0;
      const rawDiscount = D(simulatedSubtotal).times(pct).div(100);
      const capVal = parseFloat(data.maxDiscountAmount);

      if (!isNaN(capVal) && capVal > 0 && rawDiscount.gt(capVal)) {
        discount = D(capVal);
        isCapped = true;
      } else {
        discount = rawDiscount;
      }
    } else {
      const fixed = parseFloat(data.discountAmount) || 0;
      discount = D(Math.min(simulatedSubtotal, fixed));
    }

    const netTotal = D(simulatedSubtotal).minus(discount);

    return {
      discountAmount: discount,
      isCapped,
      total: netTotal.gt(0) ? netTotal : D(0),
    };
  }, [data.type, data.discountPercent, data.maxDiscountAmount, data.discountAmount, simulatedSubtotal, isMinSpendMet]);

  const barcodeSvgResult = useMemo(() => {
    try {
      return code128Svg(previewCode, {
        height: 40,
        moduleWidth: 1.5,
        quietZone: 8,
        showText: true,
      });
    } catch {
      return null;
    }
  }, [previewCode]);

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center justify-between w-full max-w-[320px]">
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Receipt className="size-3.5 text-primary" />
          <span>إيصال نقطة البيع الحراري (عرض 80 مم)</span>
        </div>
        <Badge variant={isMinSpendMet ? "outline" : "destructive"} className="text-[10px]">
          {isMinSpendMet ? (
            <span className="flex items-center gap-1">
              <CheckCircle2 className="size-3 text-primary" />
              <span>مؤهل</span>
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <AlertTriangle className="size-3" />
              <span>دون الحد الأدنى</span>
            </span>
          )}
        </Badge>
      </div>

      {/* تحكم محاكاة قيمة السلة للتحقق الفوري من صمام الأمان */}
      <div className="w-full max-w-[320px] rounded-lg border bg-muted/30 p-2.5 space-y-1.5 text-xs">
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="flex items-center gap-1">
            <SlidersHorizontal className="size-3" />
            <span>محاكاة قيمة سلة المشتريات:</span>
          </span>
          <span className="font-bold text-foreground tabular-nums">
            {formatIqd(simulatedSubtotal)}
          </span>
        </div>
        <div className="flex gap-1.5 pt-1">
          {[25000, 50000, 100000, 250000].map((amount) => (
            <button
              key={amount}
              type="button"
              className={`flex-1 rounded py-1 px-1.5 text-[10px] font-medium border transition-colors ${
                simulatedSubtotal === amount
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-muted text-muted-foreground"
              }`}
              onClick={() => setSimulatedSubtotal(amount)}
            >
              {amount / 1000} ألف
            </button>
          ))}
        </div>
      </div>

      {/* محاكاة ورقة الإيصال الحراري 80 مم */}
      <Card className="w-full max-w-[320px] bg-card text-foreground font-mono text-xs border shadow-md rounded-none border-t-4 border-t-primary/80">
        <CardContent className="p-4 space-y-3">
          {/* ترويسة الإيصال */}
          <div className="text-center space-y-1 border-b border-dashed pb-3">
            <div className="font-bold text-sm tracking-wide">{CO.short}</div>
            <div className="text-[10px] text-muted-foreground">{CO.subtitle}</div>
            <div className="text-[10px] text-muted-foreground">فرع: المنصور الرئيسي · كاشير #1</div>
            <div className="text-[9px] text-muted-foreground">فاتورة تجريبية: POS-2026-9041</div>
          </div>

          {/* بنود الفاتورة التجريبية */}
          <div className="space-y-1.5 text-[11px]">
            <div className="flex justify-between text-muted-foreground text-[10px] border-b pb-1">
              <span>الصنف</span>
              <span>المبلغ</span>
            </div>
            <div className="flex justify-between">
              <span>مشتريات قرطاسية ومواد مكتبية</span>
              <span className="tabular-nums">{formatIqd(simulatedSubtotal)}</span>
            </div>
          </div>

          {/* فاصل الفاتورة */}
          <div className="border-b border-dashed" />

          {/* المجاميع والخصومات */}
          <div className="space-y-1 text-[11px]">
            <div className="flex justify-between text-muted-foreground">
              <span>المجموع الفرعي:</span>
              <span className="tabular-nums">{formatIqd(simulatedSubtotal)}</span>
            </div>

            {/* سطر خصم الكوبون الصريح بالسالب */}
            {isMinSpendMet ? (
              <div className="flex justify-between text-destructive font-bold bg-destructive/10 px-1.5 py-1 rounded">
                <div className="flex flex-col">
                  <span>خصم كوبون ({previewCode})</span>
                  {calculation.isCapped && (
                    <span className="text-[9px] font-normal text-muted-foreground">
                      (تم تفعيل سقف الخصم الأقصى)
                    </span>
                  )}
                </div>
                <span className="tabular-nums self-center" dir="ltr">
                  -{formatIqd(calculation.discountAmount.toString())}
                </span>
              </div>
            ) : (
              <div className="text-[10px] text-destructive bg-destructive/10 p-1.5 rounded">
                لم يتم تطبيق الكوبون (الحد الأدنى للسلة هو {formatIqd(minSpend)})
              </div>
            )}

            {/* الصافي النهائي المطلوب */}
            <div className="flex justify-between text-sm font-bold border-t pt-1.5 text-foreground">
              <span>الصافي النهائي:</span>
              <span className="tabular-nums text-primary">
                {formatIqd(calculation.total.toString())}
              </span>
            </div>
          </div>

          {/* الباركود الحراري Code128 الخاص بالكوبون */}
          <div className="pt-2 border-t border-dashed text-center flex flex-col items-center justify-center">
            {barcodeSvgResult ? (
              <div
                className="w-full flex items-center justify-center overflow-hidden [&>svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: barcodeSvgResult.svg }}
                aria-label={`باركود الكوبون ${previewCode}`}
              />
            ) : (
              <div className="py-2 text-[10px] text-muted-foreground">
                رمز الباركود: {previewCode}
              </div>
            )}
            <div className="text-[9px] text-muted-foreground mt-1">
              مسح فوري عبر قارئ الباركود الضوئي (1D Code128)
            </div>
          </div>

          {/* تذييل الإيصال */}
          <div className="text-center pt-2 text-[9px] text-muted-foreground border-t border-dashed">
            <div>شكراً لتعاملكم معنا · للاستفسار {CO.phones[0]?.n ?? ""}</div>
            <div>{data.design.terms || "الكوبون يخضع لشروط العرض"}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
