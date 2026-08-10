/**
 * ActionButtons — primary save + secondary actions (draft, print, send, PDF, convert, duplicate, return).
 * Ported from `_design-bundle/project/invoice-footer.jsx#ActionButtons`.
 *
 * The page wires `onAction` to real tRPC mutations (e.g. sale.create, quotation.convert).
 */
import {
  Check,
  ClipboardList,
  ClipboardPaste,
  FilePen,
  FileText,
  Printer,
  RefreshCw,
  Send,
  Undo2,
  Zap,
} from "lucide-react";
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
  | "paste"
  | "return";

export interface ActionButtonsProps {
  invoiceType: InvoiceType;
  items: InvoiceLine[];
  onAction: (action: InvoiceActionKind) => void;
  /** Disable the primary save (e.g. while a mutation is in flight). */
  saving?: boolean;
  pasteAvailable?: boolean;
  /** الإجراءات الحقيقية التي تدعمها الشاشة الحالية. */
  availableActions?: readonly InvoiceActionKind[];
}

const DEFAULT_ACTIONS: Record<InvoiceType, readonly InvoiceActionKind[]> = {
  SALE: ["save", "print", "send", "pdf", "duplicate", "paste", "return"],
  QUOTATION: [
    "save",
    "draft",
    "print",
    "send",
    "pdf",
    "convert",
    "duplicate",
    "paste",
  ],
  PURCHASE: ["save", "draft", "print", "duplicate", "paste"],
  SALE_RETURN: ["save", "print", "pdf", "duplicate", "paste"],
  PURCHASE_RETURN: ["save", "print", "duplicate", "paste"],
};

export function ActionButtons({
  invoiceType,
  items,
  onAction,
  saving,
  pasteAvailable = false,
  availableActions = DEFAULT_ACTIONS[invoiceType],
}: ActionButtonsProps) {
  const typeInfo = INVOICE_TYPES[invoiceType];
  const isQuote = invoiceType === "QUOTATION";
  const hasItems = items.length > 0;
  const supports = (action: InvoiceActionKind) =>
    availableActions.includes(action);

  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <div className="mb-0.5 flex items-center gap-1.5 text-xs font-extrabold">
        <Zap aria-hidden className="size-4" /> الإجراءات
      </div>

      {/* Primary */}
      {supports("save") && (
        <Button
          type="button"
          disabled={!hasItems || saving}
          onClick={() => onAction("save")}
          className={cn(
            "h-11 w-full text-sm font-bold text-white",
            hasItems && typeInfo.colorBg,
          )}
        >
          {saving ? (
            "جارٍ الحفظ…"
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Check aria-hidden className="size-4" /> حفظ واعتماد
            </span>
          )}
        </Button>
      )}

      {(supports("draft") || supports("print")) && (
        <div className="grid grid-cols-2 gap-1.5">
          {supports("draft") && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction("draft")}
              className="h-11 border-amber-300/40 bg-amber-50 text-amber-700 hover:bg-amber-100"
            >
              <FilePen aria-hidden className="size-4" /> مسوّدة
            </Button>
          )}
          {supports("print") && (
            <Button
              type="button"
              variant="outline"
              disabled={!hasItems}
              onClick={() => onAction("print")}
              className="h-11"
            >
              <Printer aria-hidden className="size-4" /> حفظ وطباعة
            </Button>
          )}
        </div>
      )}

      {(supports("send") || supports("pdf")) && (
        <div className="grid grid-cols-2 gap-1.5">
          {supports("send") && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction("send")}
              className="h-11 border-emerald-300/40 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
            >
              <Send aria-hidden className="size-4" /> إرسال
            </Button>
          )}
          {supports("pdf") && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction("pdf")}
              className="h-11"
            >
              <FileText aria-hidden className="size-4" /> تصدير PDF
            </Button>
          )}
        </div>
      )}

      {isQuote && supports("convert") && (
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

      {(supports("duplicate") ||
        (supports("paste") && pasteAvailable) ||
        supports("return")) && (
        <div className="flex gap-1.5 border-t border-dashed pt-2">
          {supports("duplicate") && (
            <Button
              type="button"
              variant="outline"
              disabled={!hasItems}
              onClick={() => onAction("duplicate")}
              className="h-9 flex-1 text-xs"
            >
              <ClipboardList aria-hidden className="size-3.5" /> نسخ
            </Button>
          )}
          {supports("paste") && pasteAvailable && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction("paste")}
              className="h-9 flex-1 border-primary/40 bg-primary/10 text-xs text-primary hover:bg-primary/20"
            >
              <ClipboardPaste aria-hidden className="size-3.5" /> لصق
            </Button>
          )}
          {supports("return") && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction("return")}
              className="h-9 flex-1 border-rose-300/40 text-xs text-rose-600 hover:bg-rose-50"
            >
              <Undo2 aria-hidden className="size-3.5" /> مرتجع
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
