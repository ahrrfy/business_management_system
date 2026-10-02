/**
 * client/src/components/printing/BatchBarcodePdfButton.tsx
 *
 * زر تصدير وتحميل قائمة ملصقات الباركود كاملة بصيغة PDF متجهة عالية الدقة (300+ DPI).
 * مخصص لقائمة الطباعة في شاشة طباعة الملصقات.
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { downloadBatchBarcodePdf } from "@/lib/printing/barcodePdf";
import type { LabelSize } from "@/lib/printing/print";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileDown, ChevronDown, Loader2, Layers, Printer } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BatchItem {
  barcode: string;
  productName: string;
  unitName?: string | null;
  price?: string | null;
  sku?: string;
  count: number;
}

export interface BatchBarcodePdfButtonProps {
  items: BatchItem[];
  size: LabelSize;
  disabled?: boolean;
  className?: string;
}

export function BatchBarcodePdfButton({
  items,
  size,
  disabled = false,
  className,
}: BatchBarcodePdfButtonProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const generateBatchMut = trpc.catalog.generateBarcodeBatchPdf.useMutation();

  const validItems = (items || []).filter(
    (item) => (item.barcode || "").trim().length > 0 && item.count > 0
  );
  const totalLabels = validItems.reduce((s, q) => s + q.count, 0);
  const hasItems = validItems.length > 0;

  const handleDownload = (layout: "individual_pages" | "a4_grid" = "individual_pages") => {
    if (!hasItems) return;

    downloadBatchBarcodePdf(
      (input) => generateBatchMut.mutateAsync(input),
      {
        items: validItems.map((item) => ({
          barcode: item.barcode,
          productName: item.productName,
          unitName: item.unitName,
          retailPrice: item.price,
          sku: item.sku,
          count: item.count,
        })),
        layout,
        widthMm: size.widthMm,
        heightMm: size.heightMm,
      },
      setIsDownloading
    );
  };

  return (
    <div className={cn("inline-flex items-center rounded-md shadow-xs", className)}>
      <Button
        type="button"
        variant="outline"
        onClick={() => handleDownload("individual_pages")}
        disabled={disabled || !hasItems || isDownloading}
        title={`تحميل ملف PDF يضم كل الملصقات (${totalLabels} ملصق)`}
        className="rounded-e-none gap-1.5"
      >
        {isDownloading ? (
          <Loader2 aria-hidden className="size-4 animate-spin text-primary" />
        ) : (
          <FileDown aria-hidden className="size-4 text-primary" />
        )}
        <span>تحميل PDF للكل ({totalLabels} ملصق)</span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || !hasItems || isDownloading}
            aria-label="خيارات تصدير PDF للدفعة"
            title="خيارات تصدير PDF"
            className="rounded-s-none border-s-0 px-2"
          >
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 text-end">
          <DropdownMenuLabel className="text-xs font-semibold text-foreground">
            تصدير {totalLabels} ملصق كملف PDF عالي الدقة
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={() => handleDownload("individual_pages")}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">
                رول طابعة حرارية ({size.widthMm} × {size.heightMm} مم)
              </span>
              <span className="text-[10px] text-muted-foreground">
                صفحة مستقلة لكل ملصق — جاهزة للطباعة المتتابعة
              </span>
            </div>
            <Printer aria-hidden className="size-4 shrink-0 text-primary ms-2" />
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => handleDownload("a4_grid")}
            className="flex items-center justify-between text-xs cursor-pointer"
          >
            <div className="flex flex-col text-start">
              <span className="font-medium text-foreground">
                ورق A4 مجمّع (24 ملصق لكل ورقة)
              </span>
              <span className="text-[10px] text-muted-foreground">
                شبكة 3×8 جاهزة للطباعة المكتبية على أوراق الملصقات
              </span>
            </div>
            <Layers aria-hidden className="size-4 shrink-0 text-emerald-600 ms-2" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
