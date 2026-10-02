/**
 * client/src/components/product/BarcodePdfButton.tsx — زر تحميل باركود المنتج بصيغة PDF عالية الدقة (300+ DPI).
 *
 * صُمم خصيصاً للمصانع والورش الإنتاجية ومصممي التغليف:
 * 1. يستدعي حوار «حفظ باسم» (File System Access API) تلقائياً باسم المنتج المكتوب.
 * 2. يتيح التنزيل الفوري بنقرة واحدة بالمقاس الصناعي القياسي (50×30 مم).
 * 3. يوفّر قائمة خيارات متقدمة (50×25 مم، 60×40 مم، باركود متّجه صافٍ Artwork للمطابع، ورقة A4 كاملة 24 ملصق).
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { saveFileAs } from "@/lib/export";
import { notify } from "@/lib/notify";
import { buildBarcodePdfFilename } from "@shared/barcodeEncoding";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileDown, ChevronDown, Loader2, Sparkles, Layers, FileText, Box } from "lucide-react";
import { cn } from "@/lib/utils";

export type BarcodePdfPreset = "50x30" | "50x25" | "60x40" | "artwork" | "a4";

export interface BarcodePdfButtonProps {
  barcode: string;
  productName: string;
  unitName?: string;
  retailPrice?: string | number;
  brand?: string;
  modelName?: string;
  sku?: string;
  className?: string;
}

export function BarcodePdfButton({
  barcode,
  productName,
  unitName,
  retailPrice,
  brand,
  modelName,
  sku,
  className,
}: BarcodePdfButtonProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const generatePdfMut = trpc.catalog.generateBarcodePdf.useMutation();

  const code = (barcode || "").trim();
  const hasBarcode = code.length > 0;

  const handleDownload = (preset: BarcodePdfPreset = "50x30") => {
    if (!hasBarcode) {
      notify.err("يرجى إدخال أو توليد باركود أولاً لتحميله بصيغة PDF");
      return;
    }

    const suggestedFilename = buildBarcodePdfFilename({
      productName,
      unitName,
      barcode: code,
    });

    setIsDownloading(true);

    saveFileAs(
      async () => {
        try {
          const res = await generatePdfMut.mutateAsync({
            barcode: code,
            productName: productName.trim() || null,
            unitName: unitName?.trim() || null,
            retailPrice: retailPrice ? String(retailPrice) : null,
            brand: brand?.trim() || null,
            modelName: modelName?.trim() || null,
            sku: sku?.trim() || null,
            preset,
          });

          // تحويل base64 إلى بايتات Blob
          const binary = atob(res.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }

          notify.ok(`تم تجهيز باركود PDF عالي الدقة: ${res.filename}`);
          return {
            blob: new Blob([bytes], { type: "application/pdf" }),
            filename: res.filename || suggestedFilename,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "فشل توليد باركود PDF";
          notify.err(message);
          return null;
        } finally {
          setIsDownloading(false);
        }
      },
      {
        filename: suggestedFilename,
        description: "وثيقة باركود PDF عالي الدقة (300+ DPI)",
        mime: "application/pdf",
      }
    );
  };

  const mainTitle = hasBarcode
    ? `تحميل باركود PDF عالي الدقة (300+ DPI) باسم «${productName || "المنتج"}» للطباعة والتصنيع`
    : "أدخل أو ولّد باركوداً أولاً لتحميله بصيغة PDF";

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border bg-card shrink-0 h-8 shadow-xs",
        className
      )}
    >
      <button
        type="button"
        onClick={() => handleDownload("50x30")}
        disabled={!hasBarcode || isDownloading}
        title={mainTitle}
        aria-label="تحميل باركود PDF عالي الدقة"
        className="h-8 w-8 inline-flex items-center justify-center text-muted-foreground hover:text-primary disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
      >
        {isDownloading ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <FileDown aria-hidden className="size-3.5" />
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!hasBarcode || isDownloading}
            title="خيارات ومقاسات ملصقات PDF للتصنيع"
            aria-label="خيارات ومقاسات ملصقات PDF"
            className="h-8 px-1 inline-flex items-center justify-center border-s text-muted-foreground hover:text-primary disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronDown aria-hidden className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 text-end">
          <DropdownMenuLabel className="text-xs font-semibold text-foreground">
            تنزيل باركود PDF للطباعة والتصنيع (300+ DPI)
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={() => handleDownload("50x30")}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">ملصق قياسي (50 × 30 مم)</span>
              <span className="text-[10px] text-muted-foreground">القياس العالمي الأكثر انتشاراً لعلب المنتجات</span>
            </div>
            <FileText aria-hidden className="size-4 shrink-0 text-primary ms-2" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleDownload("50x25")}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">ملصق مدمج (50 × 25 مم)</span>
              <span className="text-[10px] text-muted-foreground">مقاس 2×1 إنش للأصناف والقطع الصغيرة</span>
            </div>
            <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground ms-2" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleDownload("60x40")}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">ملصق كراتين وتغليف (60 × 40 مم)</span>
              <span className="text-[10px] text-muted-foreground">مخصص لصناديق وكراتين الشحن الكبيرة</span>
            </div>
            <Box aria-hidden className="size-4 shrink-0 text-muted-foreground ms-2" />
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={() => handleDownload("artwork")}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">باركود متّجه صافٍ (Artwork)</span>
              <span className="text-[10px] text-muted-foreground">لبرامج التصميم والمطابع (Illustrator / Corel)</span>
            </div>
            <Sparkles aria-hidden className="size-4 shrink-0 text-amber-500 ms-2" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleDownload("a4")}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">ورقة A4 كاملة (24 ملصق)</span>
              <span className="text-[10px] text-muted-foreground">جاهزة للطباعة على طابعات الليزر والمكتبية</span>
            </div>
            <FileDown aria-hidden className="size-4 shrink-0 text-emerald-600 ms-2" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
