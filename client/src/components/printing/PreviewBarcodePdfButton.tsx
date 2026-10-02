/**
 * client/src/components/printing/PreviewBarcodePdfButton.tsx
 *
 * زر تحميل باركود المعاينة الحية بصيغة PDF متجهة عالية الدقة (300+ DPI).
 * مخصص لبطاقة المعاينة في شاشة طباعة الملصقات.
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { downloadSingleBarcodePdf } from "@/lib/printing/barcodePdf";
import type { LabelRenderItem, LabelSize } from "@/lib/printing/print";
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

export interface PreviewBarcodePdfButtonProps {
  item: LabelRenderItem;
  size: LabelSize;
  className?: string;
}

export function PreviewBarcodePdfButton({ item, size, className }: PreviewBarcodePdfButtonProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const generatePdfMut = trpc.catalog.generateBarcodePdf.useMutation();

  const code = (item.barcode || "").trim();
  const hasBarcode = code.length > 0;

  const handleDownload = (opts: {
    preset?: "50x30" | "50x25" | "60x40" | "artwork" | "a4";
    useCurrentSize?: boolean;
  }) => {
    if (!hasBarcode) return;

    downloadSingleBarcodePdf(
      (input) => generatePdfMut.mutateAsync(input),
      {
        barcode: code,
        productName: item.name,
        unitName: item.attrs?.unitName,
        retailPrice: item.price,
        sku: item.sku,
        preset: opts.preset,
        widthMm: opts.useCurrentSize ? size.widthMm : undefined,
        heightMm: opts.useCurrentSize ? size.heightMm : undefined,
      },
      setIsDownloading
    );
  };

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border bg-card shrink-0 h-8 shadow-xs",
        className
      )}
    >
      <button
        type="button"
        onClick={() => handleDownload({ useCurrentSize: true })}
        disabled={!hasBarcode || isDownloading}
        title={`تحميل PDF عالي الدقة للمعاينة بمقاس ${size.widthMm}×${size.heightMm} مم`}
        aria-label="تحميل PDF المعاينة"
        className="h-8 px-2 inline-flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-primary hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isDownloading ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <FileDown aria-hidden className="size-3.5 text-primary" />
        )}
        <span>تحميل PDF ({size.widthMm}×{size.heightMm})</span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!hasBarcode || isDownloading}
            title="خيارات ومقاسات أخرى للملصق"
            aria-label="خيارات المقاسات"
            className="h-8 px-1.5 inline-flex items-center justify-center border-s text-muted-foreground hover:text-primary hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronDown aria-hidden className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 text-end">
          <DropdownMenuLabel className="text-xs font-semibold text-foreground">
            تنزيل ملصق PDF للمعاينة الحالية
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={() => handleDownload({ useCurrentSize: true })}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">المقاس الحالي المختار</span>
              <span className="text-[10px] text-muted-foreground">{size.widthMm} × {size.heightMm} مم</span>
            </div>
            <FileText aria-hidden className="size-4 shrink-0 text-primary ms-2" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleDownload({ preset: "50x30" })}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">ملصق قياسي (50 × 30 مم)</span>
              <span className="text-[10px] text-muted-foreground">القياس العالمي الأكثر انتشاراً</span>
            </div>
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground ms-2" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleDownload({ preset: "50x25" })}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">ملصق مدمج (50 × 25 مم)</span>
              <span className="text-[10px] text-muted-foreground">مقاس 2×1 إنش للأصناف الصغيرة</span>
            </div>
            <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground ms-2" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleDownload({ preset: "60x40" })}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">ملصق كراتين (60 × 40 مم)</span>
              <span className="text-[10px] text-muted-foreground">للصناديق والشحن</span>
            </div>
            <Box aria-hidden className="size-4 shrink-0 text-muted-foreground ms-2" />
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={() => handleDownload({ preset: "artwork" })}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">باركود متّجه صافٍ (Artwork)</span>
              <span className="text-[10px] text-muted-foreground">لبرامج التصميم (Illustrator / Corel)</span>
            </div>
            <Sparkles aria-hidden className="size-4 shrink-0 text-amber-500 ms-2" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleDownload({ preset: "a4" })}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">ورقة A4 كاملة (24 ملصق)</span>
              <span className="text-[10px] text-muted-foreground">جاهزة للطباعة على طابعات الليزر</span>
            </div>
            <FileDown aria-hidden className="size-4 shrink-0 text-emerald-600 ms-2" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
