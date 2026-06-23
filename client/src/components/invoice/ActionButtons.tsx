/**
 * ActionButtons — primary save + secondary actions (draft, print, send, PDF, convert, duplicate, return).
 * Ported from `_design-bundle/project/invoice-footer.jsx#ActionButtons`.
 *
 * The page wires `onAction` to real tRPC mutations (e.g. sale.create, quotation.convert).
 */
import { Check, ClipboardList, FilePen, FileText, Printer, RefreshCw, Send, Undo2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { INVOICE_TYPES, type InvoiceLine, type InvoiceType } from "./types";

export type InvoiceActionKind =
  | "save"
  | "draft"
  | "print"
  | "send"
  | "pdf"
  | "convert"
  | "duplicate"
  | "return";

export interface ActionButtonsProps {
  invoiceType: InvoiceType;
  items: InvoiceLine[];
  onAction: (action: InvoiceActionKind) => void;
  /** Disable the primary save (e.g. while a mutation is in flight). */
  saving?: boolean;
}

export function ActionButtons({ invoiceType, items, onAction, saving }: ActionButtonsProps) {
  const typeInfo = INVOICE_TYPES[invoiceType];
  const isQuote = invoiceType === "QUOTATION";
  const hasItems = items.length > 0;

  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <div className="mb-0.5 flex items-center gap-1.5 text-xs font-extrabold">
        <Zap aria-hidden className="size-4" /> الإجراءات
      </div>

      {/* Primary */}
      <Button
        type="button"
        disabled={!hasItems || saving}
        onClick={() => onAction("save")}
        className={cn("h-11 w-full text-sm font-bold text-white", hasItems && typeInfo.colorBg)}
      >
        {saving ? (
          "جارٍ الحفظ…"
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <Check aria-hidden className="size-4" /> حفظ واعتماد
          </span>
        )}
      </Button>

      <div className="grid grid-cols-2 gap-1.5">
        <Button
          type="button"
          variant="outline"
          onClick={() => onAction("draft")}
          className="h-11 border-amber-300/40 bg-amber-50 text-amber-700 hover:bg-amber-100"
        >
          <FilePen aria-hidden className="size-4" /> مسوّدة
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!hasItems}
          onClick={() => onAction("print")}
          className="h-11"
        >
          <Printer aria-hidden className="size-4" /> حفظ وطباعة
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <Button
          type="button"
          variant="outline"
          onClick={() => onAction("send")}
          className="h-11 border-emerald-300/40 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
        >
          <Send aria-hidden className="size-4" /> إرسال
        </Button>
        <Button type="button" variant="outline" onClick={() => onAction("pdf")} className="h-11">
          <FileText aria-hidden className="size-4" /> تصدير PDF
        </Button>
      </div>

      {isQuote && (
        <Button
          type="button"
          variant="outline"
          disabled={!hasItems}
          onClick={() => onAction("convert")}
          className="h-11 w-full border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
        >
          <RefreshCw aria-hidden className="size-4" /> تحويل إلى فاتورة بيع
        </Button>
      )}

      <div className="flex gap-1.5 border-t border-dashed pt-2">
        <Button type="button" variant="outline" onClick={() => onAction("duplicate")} className="h-9 flex-1 text-xs">
          <ClipboardList aria-hidden className="size-3.5" /> نسخ
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => onAction("return")}
          className="h-9 flex-1 border-rose-300/40 text-xs text-rose-600 hover:bg-rose-50"
        >
          <Undo2 aria-hidden className="size-3.5" /> مرتجع
        </Button>
      </div>
    </section>
  );
}
