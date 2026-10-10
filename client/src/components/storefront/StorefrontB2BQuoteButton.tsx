import React, { useState } from "react";
import { FileText, Loader2, Check } from "lucide-react";
import { printQuotationV2 } from "@/lib/printing/printTemplatesV2";
import { summarizeStorefrontCustomization } from "@/pages/Storefront";

interface CartLineItem {
  cartKey: string;
  name: string;
  qty: number;
  price: string | number;
  variantLabel?: string;
  unitName?: string;
  customization?: any;
}

interface StorefrontB2BQuoteButtonProps {
  cartLines: CartLineItem[];
  cartSubtotal: number;
  className?: string;
}

export function StorefrontB2BQuoteButton({
  cartLines,
  cartSubtotal,
  className = "",
}: StorefrontB2BQuoteButtonProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGenerated, setIsGenerated] = useState(false);

  const handleGenerate = () => {
    if (cartLines.length === 0) return;
    setIsGenerating(true);

    try {
      const today = new Date();
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const quoteNumber = `QUO-${today.getFullYear()}-${randomSuffix}`;

      const expiryDate = new Date(today);
      expiryDate.setDate(expiryDate.getDate() + 15);
      const expiryFormatted = new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(expiryDate);

      const items = cartLines.map((line) => {
        const customText = summarizeStorefrontCustomization(line.customization);
        const details = [line.variantLabel, line.unitName, customText].filter(Boolean).join(" - ");
        const fullName = details ? `${line.name} (${details})` : line.name;
        const unitPrice = Number(line.price) || 0;
        const total = unitPrice * line.qty;

        return {
          productName: fullName,
          quantity: line.qty,
          unitPrice,
          total,
          taxAmount: 0,
        };
      });

      printQuotationV2({
        quoteNumber,
        quoteDate: today,
        validUntil: expiryFormatted,
        customerName: "السادة / شركة أو مؤسسة محترمة",
        deliveryLocation: "بغداد وكافة المحافظات العراقية",
        items,
        subtotal: cartSubtotal,
        discountAmount: 0,
        taxAmount: 0,
        taxRate: 0,
        total: cartSubtotal,
        terms: "عرض سعر رسمي معتمد صادر من شركة الرؤية العربية للتجارة العامة والمكتبة العربية. العرض سارٍ لمدة 15 يوماً. الأسعار شاملة وخاضعة لنسبة ضريبة 0% في جمهورية العراق. الدفع عند الاستلام أو بتحويل مصرفي معتمد.",
      });

      setIsGenerated(true);
      window.setTimeout(() => setIsGenerated(false), 3000);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleGenerate}
      disabled={isGenerating || cartLines.length === 0}
      className={`inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-xs font-black text-white shadow-xs transition hover:bg-slate-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 ${className}`}
      aria-label="تنزيل وطباعة عرض سعر رسمي B2B"
    >
      {isGenerating ? (
        <>
          <Loader2 aria-hidden className="size-4 animate-spin" />
          <span>جارٍ إعداد مستند عرض السعر…</span>
        </>
      ) : isGenerated ? (
        <>
          <Check aria-hidden className="size-4 text-emerald-400" />
          <span>تم توليد عرض السعر بنجاح</span>
        </>
      ) : (
        <>
          <FileText aria-hidden className="size-4 text-amber-400" />
          <span>تنزيل عرض سعر رسمي ومختوم (B2B PDF)</span>
        </>
      )}
    </button>
  );
}
