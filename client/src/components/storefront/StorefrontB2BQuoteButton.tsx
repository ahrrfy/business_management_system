import React, { Suspense, lazy, useState } from "react";
import Decimal from "decimal.js";
import { Building2, Check, FileText, Loader2 } from "lucide-react";
import { printQuotationV2 } from "@/lib/printing/printTemplatesV2";
import { summarizeStorefrontCustomization } from "@/components/storefront/storefrontCustomizationModel";

const StorefrontB2BQuoteDialog = lazy(() => import("./StorefrontB2BQuoteDialog"));

export interface CartLineItem {
  cartKey: string;
  productUnitId: number;
  name: string;
  qty: number;
  price: string | number;
  variantLabel?: string;
  unitName?: string;
  customization?: unknown;
}

export interface StorefrontB2BQuoteButtonProps {
  cartLines: CartLineItem[];
  cartSubtotal: number;
  orderingEnabled?: boolean;
  turnstileSiteKey?: string | null;
  customerSessionToken?: string | null;
  className?: string;
}

function toDecimalSafe(val: unknown): Decimal {
  if (val === null || val === undefined || val === "") return new Decimal(0);
  try {
    return new Decimal(val as Decimal.Value);
  } catch {
    return new Decimal(0);
  }
}

export function StorefrontB2BQuoteButton({
  cartLines,
  cartSubtotal: _cartSubtotal,
  orderingEnabled = true,
  turnstileSiteKey = null,
  customerSessionToken = null,
  className = "",
}: StorefrontB2BQuoteButtonProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGenerated, setIsGenerated] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hasOpenedDialog, setHasOpenedDialog] = useState(false);

  const openQuoteDialog = () => {
    setHasOpenedDialog(true);
    setDialogOpen(true);
  };

  const handleGenerate = () => {
    if (cartLines.length === 0) return;
    setIsGenerating(true);

    try {
      const today = new Date();
      const quoteNumber = `EST-${today.toISOString().slice(0, 10).replace(/-/g, "")}-B2B`;

      const expiryDate = new Date(today);
      expiryDate.setDate(expiryDate.getDate() + 15);
      const expiryFormatted = new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(expiryDate);

      let computedSubtotal = new Decimal(0);

      const items = cartLines.map((line) => {
        const customText = summarizeStorefrontCustomization(line.customization as never);
        const details = [line.variantLabel, line.unitName, customText].filter(Boolean).join(" - ");
        const fullName = details ? `${line.name} (${details})` : line.name;
        const decUnitPrice = toDecimalSafe(line.price);
        const decQty = toDecimalSafe(line.qty);
        const decLineTotal = decUnitPrice.mul(decQty);
        computedSubtotal = computedSubtotal.plus(decLineTotal);

        return {
          productName: fullName,
          quantity: line.qty,
          unitPrice: decUnitPrice.toFixed(2),
          total: decLineTotal.toFixed(2),
          taxAmount: 0,
        };
      });

      const finalSubtotal = computedSubtotal.toFixed(2);

      printQuotationV2({
        quoteNumber,
        quoteDate: today,
        validUntil: expiryFormatted,
        customerName: "السادة / شركة أو مؤسسة محترمة",
        deliveryLocation: "بغداد وكافة المحافظات العراقية",
        items,
        subtotal: finalSubtotal,
        discountAmount: 0,
        taxAmount: 0,
        taxRate: 0,
        total: finalSubtotal,
        terms: "عرض سعر تقديري صادر من متجر شركة الرؤية العربية للتجارة العامة والمكتبة العربية. العرض سارٍ لمدة 15 يوماً. الأسعار شاملة ومطابقة لقوائم الأسعار المعلنة وخاضعة لنسبة ضريبة 0% في جمهورية العراق. لاعتماد عرض سعر رسمي ومختوم برقم مرجعي للمؤسسات، يرجى تقديم طلب عرض السعر المباشر أو التواصل مع الإدارة.",
      });

      setIsGenerated(true);
      window.setTimeout(() => setIsGenerated(false), 3000);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <button
        type="button"
        onClick={openQuoteDialog}
        disabled={cartLines.length === 0}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#183D36]/25 bg-[#183D36] px-4 py-3 text-xs font-black text-white shadow-xs transition hover:opacity-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
        aria-label="تقديم طلب عرض سعر رسمي للشركات"
      >
        <Building2 aria-hidden className="size-4 shrink-0" />
        <span>طلب عرض سعر رسمي للشركات والمؤسسات</span>
      </button>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={isGenerating || cartLines.length === 0}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-xs font-black text-white shadow-xs transition hover:bg-slate-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        aria-label="تنزيل وطباعة عرض سعر تقديري B2B PDF"
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
            <span>تنزيل عرض سعر تقديري فوري (B2B PDF)</span>
          </>
        )}
      </button>

      {(dialogOpen || hasOpenedDialog) && (
        <Suspense fallback={null}>
          <StorefrontB2BQuoteDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            cartLines={cartLines}
            orderingEnabled={orderingEnabled}
            turnstileSiteKey={turnstileSiteKey}
            customerSessionToken={customerSessionToken}
          />
        </Suspense>
      )}
    </div>
  );
}
