import { useMemo, useState } from "react";
import { Receipt, AlertTriangle, CheckCircle2, SlidersHorizontal, Printer, QrCode } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { D, formatIqd, moneyInput } from "@/lib/money";
import { code128Svg } from "@/lib/printing/barcode";
import { qrSvgSync } from "@/lib/printing/qr";
import { CO, CAIRO_FONT, esc } from "@/lib/printing/brand";
import { publicStorefrontUrl } from "@/lib/siteHosts";
import { notify } from "@/lib/notify";
import type { PromotionFormData } from "./promotionBuilderTypes";

interface LiveReceiptPreviewProps {
  data: PromotionFormData;
}

export function LiveReceiptPreview({ data }: LiveReceiptPreviewProps) {
  // محاكاة سلة مشتريات ديناميكية لتجربة صمامات الأمان المالية مباشرة على الإيصال
  const [simulatedSubtotal, setSimulatedSubtotal] = useState<number>(75000);
  const [printing, setPrinting] = useState<boolean>(false);

  const previewCode = useMemo(() => {
    const raw = data.sampleCode.trim() || `${data.codePrefix || "VIP"}-8899`;
    return raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  }, [data.sampleCode, data.codePrefix]);

  const smartStoreUrl = useMemo(() => {
    return publicStorefrontUrl(previewCode);
  }, [previewCode]);

  const displayStoreHost = "alarabiya.online/store";

  const minSpend = useMemo(() => {
    return moneyInput(data.minOrderSpend);
  }, [data.minOrderSpend]);

  const isMinSpendMet = D(simulatedSubtotal).gte(minSpend);

  const isScoped = data.scope === "CATEGORIES" || data.scope === "PRODUCTS";
  const hasSelectedTargets =
    data.scope === "ALL" ||
    (data.scope === "CATEGORIES" && data.targetCategoryIds.length > 0) ||
    (data.scope === "PRODUCTS" && data.targetProductIds.length > 0);

  // الحساب المالي الدقيق للخصم مع احترام نطاق الأصناف والسقف المالي والحد الأدنى
  const calculation = useMemo(() => {
    const subtotal = D(simulatedSubtotal);

    // إذا كان العرض مقيداً بنطاق أصناف/تصنيفات محددة، نحدد الحصة المشمولة من السلة التجريبية أولاً
    let eligibleAmount = subtotal;
    let unrelatedAmount = D(0);
    let hasEligibleItems = true;

    if (isScoped) {
      if (!hasSelectedTargets) {
        eligibleAmount = D(0);
        unrelatedAmount = subtotal;
        hasEligibleItems = false;
      } else {
        // نمذجة سلة تحتوي على أصناف مشمولة (60٪) وأصناف عامة غير مشمولة (40٪)
        eligibleAmount = subtotal.times(0.6).round();
        unrelatedAmount = subtotal.minus(eligibleAmount);
      }
    }

    if (!isMinSpendMet) {
      return {
        discountAmount: D(0),
        isCapped: false,
        total: subtotal,
        eligibleAmount,
        unrelatedAmount,
        hasEligibleItems,
      };
    }

    let discount = D(0);
    let isCapped = false;

    if (hasEligibleItems && eligibleAmount.gt(0)) {
      if (data.type === "PERCENT") {
        const pct = moneyInput(data.discountPercent);
        const rawDiscount = eligibleAmount.times(pct).div(100);
        const capVal = moneyInput(data.maxDiscountAmount);

        if (capVal.greaterThan(0) && rawDiscount.gt(capVal)) {
          discount = capVal;
          isCapped = true;
        } else {
          discount = rawDiscount;
        }
      } else {
        const fixed = moneyInput(data.discountAmount);
        discount = fixed.greaterThan(eligibleAmount) ? eligibleAmount : fixed;
      }
    }

    const netTotal = subtotal.minus(discount);

    return {
      discountAmount: discount,
      isCapped,
      total: netTotal.gt(0) ? netTotal : D(0),
      eligibleAmount,
      unrelatedAmount,
      hasEligibleItems,
    };
  }, [
    data.type,
    data.discountPercent,
    data.maxDiscountAmount,
    data.discountAmount,
    simulatedSubtotal,
    isMinSpendMet,
    isScoped,
    hasSelectedTargets,
  ]);

  const barcodeSvgResult = useMemo(() => {
    try {
      return code128Svg(previewCode, {
        height: 42,
        moduleWidth: 1.6,
        quietZone: 8,
        showText: true,
      });
    } catch {
      return null;
    }
  }, [previewCode]);

  const qrSvg = useMemo(() => {
    return qrSvgSync(smartStoreUrl, 110);
  }, [smartStoreUrl]);

  function handlePrintReceipt() {
    setPrinting(true);
    let win: Window | null = null;
    try {
      win = window.open("", "_blank", "width=400,height=700");
      if (!win) {
        notify.err("يرجى السماح بالنوافذ المنبثقة لطباعة الإيصال الحراري");
        setPrinting(false);
        return;
      }

      const termsLen = (data.design.terms || "").length;
      const titleLen = (data.design.title || data.name || "").length;
      const subtitleLen = (data.design.subtitle || "").length;
      const estimatedReceiptHeightMm = Math.max(
        240,
        190 + Math.ceil((termsLen + titleLen + subtitleLen) / 25) * 5 + (isScoped ? 35 : 0)
      );

      const receiptHtml = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>إيصال حراري - ${esc(previewCode)}</title>
  ${CAIRO_FONT}
  <style>
    @page { size: 80mm ${estimatedReceiptHeightMm}mm; margin: 0; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 4mm;
      width: 80mm;
      font-family: 'Cairo', 'Noto Sans Arabic', Arial, sans-serif;
      font-size: 11.5px;
      font-weight: 700;
      line-height: 1.4;
      color: #000;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .header { text-align: center; border-bottom: 2px dashed #000; padding-bottom: 3mm; margin-bottom: 3mm; }
    .brand { font-size: 17px; font-weight: 900; letter-spacing: 0.3px; }
    .subtitle { font-size: 11px; font-weight: 800; color: #000; }
    .store-meta { font-size: 10.5px; font-weight: 700; color: #000; margin-top: 0.8mm; }
    .voucher-box {
      border: 2px dashed #000;
      border-radius: 2mm;
      padding: 3mm 2mm;
      margin: 3mm 0;
      text-align: center;
      background: #fff;
    }
    .voucher-title {
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 1px;
      border-bottom: 1.5px solid #000;
      padding-bottom: 1.5mm;
      margin-bottom: 2mm;
    }
    .offer-name {
      font-size: 13.5px;
      font-weight: 900;
      margin: 1.5mm 0;
      color: #000;
    }
    .hero-discount {
      font-size: 19px;
      font-weight: 900;
      margin: 2mm 0;
      padding: 1.5mm 3.5mm;
      border: 2px solid #000;
      display: inline-block;
      border-radius: 1.5mm;
      color: #000;
    }
    .limit-row {
      font-size: 11px;
      font-weight: 800;
      color: #000;
      margin: 0.8mm 0;
    }
    .code-pill {
      display: inline-block;
      background: #000;
      color: #fff;
      font-family: ui-monospace, Consolas, monospace;
      font-size: 15px;
      font-weight: 900;
      padding: 2mm 4mm;
      border-radius: 1.5mm;
      letter-spacing: 2px;
      margin: 2mm 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .totals { border-top: 2px dashed #000; padding-top: 2.5mm; margin-top: 2.5mm; }
    .row { display: flex; justify-content: space-between; margin-bottom: 1.2mm; font-size: 11.5px; font-weight: 700; color: #000; }
    .row.bold { font-weight: 900; font-size: 13.5px; border-top: 2px solid #000; padding-top: 2mm; margin-top: 1.5mm; }
    .barcode { text-align: center; margin: 3mm 0; }
    .barcode svg { max-width: 100%; height: auto; }
    .qr { width: 32mm; height: 32mm; margin: 2mm auto; }
    .qr svg { width: 100%; height: 100%; display: block; }
    .scan-hint { font-size: 10px; font-weight: 900; color: #000; margin-top: 1mm; }
    .footer { text-align: center; border-top: 2px dashed #000; padding-top: 2.5mm; font-size: 10px; font-weight: 800; color: #000; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">${esc(CO.short)}</div>
    <div class="subtitle">${esc(CO.subtitle)}</div>
    <div class="store-meta">فرع المنصور الرئيسي · كاشير #1</div>
    <div class="store-meta">إيصال تجريبي: POS-${new Date().getFullYear()}-COUPON</div>
  </div>

  ${data.archetype === "DIRECT_PROMO" ? `
  <div class="voucher-box" style="border: 2px solid #000; background: #fafafa;">
    <div class="voucher-title">*** خصم ترويجي مباشر تلقائي ***</div>
    <div class="offer-name">${esc(data.name || "عرض خصم مباشر")}</div>
    <div class="hero-discount">
      ${data.type === "PERCENT" ? `خصم ${esc(data.discountPercent || "0")}٪` : `خصم ${esc(formatIqd(data.discountAmount || "0"))}`}
    </div>
    <div class="scan-hint">مطبق آلياً على بنود الفاتورة دون الحاجة لكود كوبون</div>
  </div>
  ` : `
  <div class="voucher-box">
    <div class="voucher-title">*** قسيمة خصم ترويجية معتمدة ***</div>
    <div class="offer-name">${esc(data.design.title || data.name || "عرض ترويجي حصري")}</div>
    <div class="hero-discount">
      ${data.type === "PERCENT" ? `خصم ${esc(data.discountPercent || "0")}٪` : `خصم ${esc(formatIqd(data.discountAmount || "0"))}`}
    </div>
    ${data.type === "PERCENT" && moneyInput(data.maxDiscountAmount).greaterThan(0) ? `<div class="limit-row">سقف التوفير الأقصى: ${esc(formatIqd(data.maxDiscountAmount))}</div>` : ""}
    ${moneyInput(data.minOrderSpend).greaterThan(0) ? `<div class="limit-row">الحد الأدنى للفاتورة: ${esc(formatIqd(data.minOrderSpend))}</div>` : ""}
    ${data.design.subtitle ? `<div class="limit-row" style="margin-top: 1mm;">${esc(data.design.subtitle)}</div>` : ""}
    ${isScoped ? `<div class="limit-row">نطاق الخصم: ${data.scope === "CATEGORIES" ? "تصنيفات محددة" : "منتجات محددة"}</div>` : ""}
    <div><span class="code-pill" dir="ltr">${esc(previewCode)}</span></div>
    <div class="qr">${qrSvg || ""}</div>
    <div class="scan-hint">امسح للطلب أونلاين أو أبرز الرمز للكاشير</div>
  </div>
  `}

  <div class="totals">
    ${isScoped ? `
    <div class="row">
      <span>أصناف مشمولة (${data.scope === "CATEGORIES" ? "تصنيفات مختارة" : "منتجات مختارة"}):</span>
      <span>${formatIqd(calculation.eligibleAmount.toString())}</span>
    </div>
    ${calculation.unrelatedAmount.gt(0) ? `
    <div class="row">
      <span>أصناف عامة غير مشمولة:</span>
      <span>${formatIqd(calculation.unrelatedAmount.toString())}</span>
    </div>
    ` : ""}
    <div class="row" style="border-top: 1.5px dashed #000; padding-top: 1.5mm; margin-top: 1.5mm;">
      <span>إجمالي السلة التجريبية:</span>
      <span>${formatIqd(simulatedSubtotal)}</span>
    </div>
    ` : `
    <div class="row">
      <span>مشتريات قرطاسية ومواد مكتبية:</span>
      <span>${formatIqd(simulatedSubtotal)}</span>
    </div>
    `}
    ${isMinSpendMet ? (
      calculation.discountAmount.gt(0) ? `
      <div class="row" style="font-weight: 900; font-size: 12.5px;">
        <span>خصم كوبون (${esc(previewCode)})${calculation.isCapped ? " (سقف الخصم)" : ""}:</span>
        <span dir="ltr">-${formatIqd(calculation.discountAmount.toString())}</span>
      </div>
      ` : isScoped && !calculation.hasEligibleItems ? `
      <div style="font-size: 10px; font-weight: 800; border: 1.5px dashed #000; padding: 2mm; margin: 1.5mm 0; text-align: center;">
        لم يُطبّق الخصم: لا توجد عناصر مشمولة في السلة الحالية
      </div>
      ` : ""
    ) : `
      <div style="font-size: 10px; font-weight: 800; border: 1.5px dashed #000; padding: 2mm; margin: 1.5mm 0; text-align: center;">
        لم يُطبّق الخصم: السلة دون الحد الأدنى المطلوب (${formatIqd(minSpend.toString())})
      </div>
    `}
    <div class="row bold">
      <span>الصافي المطلوب للدفع:</span>
      <span>${formatIqd(calculation.total.toString())}</span>
    </div>
  </div>

  ${data.archetype !== "DIRECT_PROMO" ? `
  <div class="barcode">
    ${barcodeSvgResult ? barcodeSvgResult.svg : `<div>${esc(previewCode)}</div>`}
  </div>
  ` : ""}

  <div class="footer">
    <div>شكراً لتعاملكم معنا · للاستفسار: ${esc(CO.phones[0]?.n ?? "")}</div>
    <div>${esc(data.design.terms || "تُطبق الشروط والأحكام الخاصة بالعرض")}</div>
    <div>متجرنا الإلكتروني: ${esc(displayStoreHost)}</div>
  </div>

  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); window.close(); }, 200);
    };
  </script>
</body>
</html>`;

      win.document.open();
      win.document.write(receiptHtml);
      win.document.close();

      const cleanupTimer = setInterval(() => {
        if (!win || win.closed) {
          clearInterval(cleanupTimer);
          setPrinting(false);
        }
      }, 500);

      setTimeout(() => {
        clearInterval(cleanupTimer);
        setPrinting(false);
      }, 15000);
    } catch {
      notify.err("تعذر فتح نافذة الطباعة الحرارية");
      setPrinting(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center justify-between w-full max-w-[340px]">
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Receipt className="size-3.5 text-primary" />
          <span>إيصال نقطة البيع الحراري (عرض 80 مم)</span>
        </div>
        {!isMinSpendMet ? (
          <Badge variant="destructive" className="text-[10px]">
            <span className="flex items-center gap-1">
              <AlertTriangle className="size-3" />
              <span>دون الحد الأدنى</span>
            </span>
          </Badge>
        ) : !calculation.hasEligibleItems ? (
          <Badge variant="secondary" className="text-[10px] text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-800">
            <span className="flex items-center gap-1">
              <AlertTriangle className="size-3" />
              <span>غير مشمول بالسلة</span>
            </span>
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="size-3 text-primary" />
              <span>مؤهل للخصم</span>
            </span>
          </Badge>
        )}
      </div>

      {/* تحكم محاكاة قيمة السلة للتحقق الفوري من صمام الأمان */}
      <div className="w-full max-w-[340px] rounded-lg border bg-muted/30 p-2.5 space-y-1.5 text-xs">
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

      {/* محاكاة ورقة الإيصال الحراري 80 مم بتباين عالي جداً */}
      <Card className="w-full max-w-[340px] bg-white text-black font-sans text-xs border-2 border-black/20 shadow-xl rounded-none border-t-4 border-t-black">
        <CardContent className="p-4 space-y-3">
          {/* ترويسة الإيصال */}
          <div className="text-center space-y-1 border-b-2 border-black border-dashed pb-3">
            <div className="font-black text-base tracking-wide text-black">{CO.short}</div>
            <div className="text-[11px] font-extrabold text-black">{CO.subtitle}</div>
            <div className="text-[10.5px] font-bold text-black">فرع المنصور الرئيسي · كاشير #1</div>
            <div className="text-[10px] font-mono font-bold text-black">فاتورة تجريبية: POS-2026-9041</div>
          </div>

          {/* صندوق القسيمة الترويجية البارز داخل الإيصال (Promotional Voucher Box) */}
          {data.archetype === "DIRECT_PROMO" ? (
            <div className="border-2 border-solid border-black rounded-lg p-3 bg-zinc-50 text-center space-y-1.5 my-2">
              <div className="text-[10px] uppercase font-black tracking-widest text-black border-b border-black pb-1 mb-1">
                *** خصم ترويجي مباشر تلقائي ***
              </div>
              <div className="font-black text-sm text-black leading-tight">
                {data.name || "عرض خصم مباشر"}
              </div>
              <div className="font-black text-xl text-black tracking-tight my-1 inline-block border-2 border-black rounded px-3 py-1 bg-white">
                {data.type === "PERCENT" ? `خصم ${data.discountPercent || "0"}٪` : `خصم ${formatIqd(data.discountAmount || "0")}`}
              </div>
              <div className="text-[10px] font-bold text-black text-center pt-0.5">
                مطبق آلياً على بنود الفاتورة في الكاشير والمتجر دون الحاجة لكود كوبون
              </div>
            </div>
          ) : (
            <div className="border-2 border-dashed border-black rounded-lg p-3 bg-white text-center space-y-1.5 my-2">
              <div className="text-[10px] uppercase font-black tracking-widest text-black border-b border-black pb-1 mb-1">
                *** قسيمة خصم ترويجية معتمدة ***
              </div>
              <div className="font-black text-sm text-black leading-tight">
                {data.design.title || data.name || "عرض ترويجي حصري"}
              </div>

              {/* رقم الخصم البارز */}
              <div className="font-black text-xl text-black tracking-tight my-1 inline-block border-2 border-black rounded px-3 py-1 bg-zinc-50">
                {data.type === "PERCENT" ? `خصم ${data.discountPercent || "0"}٪` : `خصم ${formatIqd(data.discountAmount || "0")}`}
              </div>

              {data.type === "PERCENT" && moneyInput(data.maxDiscountAmount).greaterThan(0) && (
                <div className="text-[10.5px] font-extrabold text-black">
                  سقف التوفير الأقصى: {formatIqd(data.maxDiscountAmount)}
                </div>
              )}

              {moneyInput(data.minOrderSpend).greaterThan(0) && (
                <div className="text-[10.5px] font-extrabold text-black">
                  الحد الأدنى للفاتورة: {formatIqd(data.minOrderSpend)}
                </div>
              )}

              {/* كود الكوبون البارز بخلفية سوداء وخط أبيض ناصع */}
              <div>
                <span className="my-1.5 inline-block bg-black text-white px-3.5 py-1 rounded font-mono text-base font-black tracking-widest" dir="ltr">
                  {previewCode}
                </span>
              </div>

              {/* رمز الاستجابة السريعة QR للطلب أونلاين */}
              {qrSvg && (
                <div className="flex flex-col items-center justify-center pt-1">
                  <div
                    className="size-24 flex items-center justify-center bg-white p-1 rounded border-2 border-black [&>svg]:size-full"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                    aria-label={`رمز QR للكوبون ${previewCode}`}
                  />
                  <span className="text-[9.5px] font-black text-black mt-1">
                    امسح للطلب أونلاين أو أبرز الرمز للكاشير
                  </span>
                </div>
              )}
            </div>
          )}

          {/* بنود الفاتورة والمجاميع */}
          <div className="space-y-1.5 text-xs border-t-2 border-black border-dashed pt-2">
            <div className="flex justify-between font-black text-black text-[11px] border-b border-black pb-1">
              <span>الصنف / البند</span>
              <span>المبلغ</span>
            </div>
            {isScoped ? (
              <>
                <div className="flex justify-between font-bold text-black">
                  <span>
                    أصناف مشمولة بالعرض ({data.scope === "CATEGORIES" ? "تصنيفات مختارة" : "منتجات مختارة"})
                  </span>
                  <span className="tabular-nums font-black">
                    {formatIqd(calculation.eligibleAmount.toString())}
                  </span>
                </div>
                {calculation.unrelatedAmount.gt(0) && (
                  <div className="flex justify-between font-bold text-black text-[11px]">
                    <span>أصناف عامة غير مشمولة بالعرض</span>
                    <span className="tabular-nums">
                      {formatIqd(calculation.unrelatedAmount.toString())}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="flex justify-between font-bold text-black">
                <span>مشتريات قرطاسية ومواد مكتبية</span>
                <span className="tabular-nums font-black">{formatIqd(simulatedSubtotal)}</span>
              </div>
            )}
          </div>

          {/* فاصل الفاتورة */}
          <div className="border-b-2 border-black border-dashed" />

          {/* المجاميع والخصومات */}
          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-black font-bold">
              <span>المجموع الفرعي:</span>
              <span className="tabular-nums font-black">{formatIqd(simulatedSubtotal)}</span>
            </div>

            {/* سطر خصم الكوبون الصريح بالسالب بتباين عالي جداً */}
            {isMinSpendMet ? (
              calculation.discountAmount.gt(0) ? (
                <div className="flex justify-between text-black font-black bg-zinc-100 px-2 py-1 rounded border-2 border-black">
                  <div className="flex flex-col">
                    <span>خصم كوبون ({previewCode})</span>
                    {calculation.isCapped && (
                      <span className="text-[10px] font-extrabold text-black">
                        (تم تفعيل سقف الخصم الأقصى)
                      </span>
                    )}
                  </div>
                  <span className="tabular-nums self-center text-sm font-black" dir="ltr">
                    -{formatIqd(calculation.discountAmount.toString())}
                  </span>
                </div>
              ) : isScoped && !calculation.hasEligibleItems ? (
                <div className="text-[10px] font-bold text-amber-800 bg-amber-50 p-1.5 rounded border border-amber-300">
                  لم يتم احتساب خصم (يرجى اختيار {data.scope === "CATEGORIES" ? "التصنيفات" : "المنتجات"} المشمولة أولاً)
                </div>
              ) : null
            ) : (
              <div className="text-[10px] font-bold text-red-700 bg-red-50 p-1.5 rounded border border-red-300">
                لم يتم تطبيق الكوبون (الحد الأدنى للسلة هو {formatIqd(minSpend.toString())})
              </div>
            )}

            {/* الصافي النهائي المطلوب */}
            <div className="flex justify-between text-sm font-black border-t-2 border-black pt-1.5 text-black">
              <span>الصافي المطلوب للدفع:</span>
              <span className="tabular-nums text-base font-black">
                {formatIqd(calculation.total.toString())}
              </span>
            </div>
          </div>

          {/* الباركود الحراري Code128 الخاص بالكوبون (للكوبونات فقط) */}
          {data.archetype !== "DIRECT_PROMO" && (
            <div className="pt-2 border-t-2 border-black border-dashed text-center flex flex-col items-center justify-center">
              {barcodeSvgResult ? (
                <div
                  className="w-full flex items-center justify-center overflow-hidden [&>svg]:max-w-full"
                  dangerouslySetInnerHTML={{ __html: barcodeSvgResult.svg }}
                  aria-label={`باركود الكوبون ${previewCode}`}
                />
              ) : (
                <div className="py-2 text-[10px] font-bold text-black">
                  رمز الباركود: {previewCode}
                </div>
              )}
              <div className="text-[10px] font-black text-black mt-1">
                مسح فوري عبر قارئ الباركود الضوئي (1D Code128)
              </div>
            </div>
          )}

          {/* تذييل الإيصال */}
          <div className="text-center pt-2 text-[10px] font-bold text-black border-t-2 border-black border-dashed space-y-0.5">
            <div>شكراً لتعاملكم معنا · للاستفسار: {CO.phones[0]?.n ?? ""}</div>
            <div>{data.design.terms || "الكوبون يخضع لشروط العرض الترويجي"}</div>
            <div>متجرنا الإلكتروني: <span className="font-mono font-bold text-black">{displayStoreHost}</span></div>
          </div>
        </CardContent>
      </Card>

      {/* زر تجربة الطباعة الحرارية المباشرة */}
      <div className="w-full max-w-[340px]">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-xs font-semibold gap-1.5"
          onClick={handlePrintReceipt}
          disabled={printing}
        >
          <Printer className="size-3.5" />
          <span>{printing ? "جارٍ إرسال الإيصال للطابعة…" : "طباعة تجريبية على طابعة الفواتير (80 مم)"}</span>
        </Button>
      </div>
    </div>
  );
}
